// The production server in a subprocess, under a process named claude, with
// only Telegram's HTTP replaced offline by telegram-preload.ts. Shared by the
// integration tests; these tests never use the owner's bot.
import { spawn, type ChildProcess } from 'child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export const children: ChildProcess[] = []
const dirs: string[] = []

export function state(access: object = { dmPolicy: 'allowlist', allowFrom: ['1'] }): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-polling-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'access.json'), JSON.stringify(access))
  return dir
}

export async function until(check: () => boolean, timeout = 4000): Promise<void> {
  const end = Date.now() + timeout
  while (!check()) {
    if (Date.now() > end) throw new Error('subprocess did not reach expected state')
    await Bun.sleep(10)
  }
}

export type Call = { pid: number; method: string; payload: any; at: number; message_id?: number; refused?: string }
export function calls(dir: string): Call[] {
  const file = join(dir, 'api.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}

// A round of updates for the next getUpdates, written whole before the fake
// can read it.
export function deliver(dir: string, updates: object[]): void {
  const file = join(dir, 'inbound.json')
  writeFileSync(`${file}.tmp`, JSON.stringify(updates.map((u, i) => ({ update_id: i + 1, ...u }))))
  renameSync(`${file}.tmp`, file)
}

export function start(dir: string, argv: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [join(import.meta.dir, 'claude-parent.ts'), ...argv.slice(1)], {
    argv0: argv[0],
    env: {
      ...process.env,
      TELEGRAM_STATE_DIR: dir,
      TELEGRAM_BOT_TOKEN: '123:test-token',
      TELEGRAM_ACCESS_MODE: 'static',
      TELEGRAM_RICH_MESSAGES: 'false',
      TELEGRAM_STT_OPENAI_KEY: '',
      TELEGRAM_TEST_API_LOG: join(dir, 'api.jsonl'),
      TELEGRAM_TEST_INBOUND: join(dir, 'inbound.json'),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  let output = ''
  let id = 0
  const replies = new Map<number, (value: any) => void>()
  // Notifications the server sent Claude, such as inbound channel messages.
  const notifications: { method: string; params: any }[] = []
  child.stdout.on('data', chunk => {
    output += chunk
    let newline: number
    while ((newline = output.indexOf('\n')) >= 0) {
      const message = JSON.parse(output.slice(0, newline))
      output = output.slice(newline + 1)
      if (message.id === undefined) notifications.push(message)
      replies.get(message.id)?.(message)
      replies.delete(message.id)
    }
  })
  async function request(method: string, params: object, timeout = 4000) {
    const next = ++id
    const response = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out: ${stderr}`)), timeout)
      replies.set(next, value => { clearTimeout(timer); resolve(value) })
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n')
    return response
  }
  return {
    child, request, stderr: () => stderr,
    // A notification from Claude Code, such as a permission prompt.
    notify(method: string, params: object) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    },
    notifications,
    inbound: () => notifications.filter(n => n.method === 'notifications/claude/channel').map(n => n.params),
    async ready() {
      await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    },
    async close() { child.stdin.end(); await until(() => child.exitCode !== null) },
  }
}
export type Server = ReturnType<typeof start>

// Each test file runs this after each test: it ends the servers the test
// started and removes their state folders.
export async function cleanup(): Promise<void> {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin?.end()
      await until(() => child.exitCode !== null || child.signalCode !== null)
    }
  }
  for (const dir of dirs.splice(0)) {
    // A test may leave its state folder read-only.
    try { chmodSync(dir, 0o700) } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
}
