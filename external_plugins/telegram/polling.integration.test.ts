import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import fixture from './fixtures/channel-argv.json'

const children: ChildProcessWithoutNullStreams[] = []
const dirs: string[] = []
function state(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-polling-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['1'] }))
  return dir
}
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 4000
  while (!check()) {
    if (Date.now() > end) throw new Error('subprocess did not reach expected state')
    await Bun.sleep(10)
  }
}
function calls(dir: string): { pid: number; method: string }[] {
  const file = join(dir, 'api.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}
function start(dir: string, argv: string[]) {
  const child = spawn(process.execPath, [join(import.meta.dir, 'fixtures', 'claude-parent.ts'), ...argv.slice(1)], {
    argv0: argv[0],
    env: {
      ...process.env,
      TELEGRAM_STATE_DIR: dir,
      TELEGRAM_BOT_TOKEN: '123:test-token',
      TELEGRAM_ACCESS_MODE: 'static',
      TELEGRAM_RICH_MESSAGES: 'false',
      TELEGRAM_STT_OPENAI_KEY: '',
      TELEGRAM_TEST_API_LOG: join(dir, 'api.jsonl'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  let output = ''
  let id = 0
  const replies = new Map<number, (value: any) => void>()
  child.stdout.on('data', chunk => {
    output += chunk
    let newline: number
    while ((newline = output.indexOf('\n')) >= 0) {
      const message = JSON.parse(output.slice(0, newline))
      output = output.slice(newline + 1)
      replies.get(message.id)?.(message)
      replies.delete(message.id)
    }
  })
  async function request(method: string, params: object) {
    const next = ++id
    const response = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out: ${stderr}`)), 4000)
      replies.set(next, value => { clearTimeout(timer); resolve(value) })
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n')
    return response
  }
  return {
    child, request, stderr: () => stderr,
    async ready() {
      await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    },
    async close() { child.stdin.end(); await until(() => child.exitCode !== null) },
  }
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end()
      await until(() => child.exitCode !== null || child.signalCode !== null)
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Real /proc ancestry, real MCP transport, and the production server. Only
// grammy's HTTP transport is fake; these tests never use the owner's bot.
describe.skipIf(process.platform !== 'linux')('polling ownership in the running server', () => {
  test.each([
    ['claude', '-p', 'hello'],
    ['claude', 'mcp', 'list'],
    ['claude', '--continue'],
  ])('a non-channel session sends without polling or touching a live holder: %j', async (...argv) => {
    const dir = state()
    const channel = start(dir, fixture.argv)
    await channel.ready()
    await until(() => calls(dir).some(call => call.method === 'getUpdates') && existsSync(join(dir, 'poll-heartbeat.json')))
    const holder = readFileSync(join(dir, 'bot.pid'), 'utf8')
    const before = statSync(join(dir, 'bot.pid')).mtimeMs
    const sentBefore = calls(dir).length
    const sender = start(dir, argv)
    await sender.ready()
    const tools = await sender.request('tools/list', {})
    expect(tools.result.tools.some((tool: { name: string }) => tool.name === 'reply')).toBe(true)
    const sent = await sender.request('tools/call', { name: 'reply', arguments: { chat_id: '1', text: 'offline test' } })
    expect(sent.result.isError).not.toBe(true)
    const send = calls(dir).slice(sentBefore).find(call => call.method === 'sendMessage')!
    expect(send).toBeDefined()
    expect(calls(dir).filter(call => call.pid === send.pid).map(call => call.method)).toEqual(['sendMessage'])
    await sender.close()
    expect(readFileSync(join(dir, 'bot.pid'), 'utf8')).toBe(holder)
    expect(statSync(join(dir, 'bot.pid')).mtimeMs).toBe(before)
    expect(JSON.parse(readFileSync(join(dir, 'poll-heartbeat.json'), 'utf8')).pid).toBe(Number(holder))
    expect(channel.child.exitCode).toBeNull()
    expect(sender.stderr()).toContain('send-only')
    await channel.close()
    expect(existsSync(join(dir, 'bot.pid'))).toBe(false)
  })

  test('a send-only instance creates neither bot.pid nor a heartbeat', async () => {
    const dir = state()
    const sender = start(dir, ['claude', 'mcp', 'list'])
    await sender.ready()
    await sender.close()
    expect(calls(dir)).toEqual([])
    expect(existsSync(join(dir, 'bot.pid'))).toBe(false)
    expect(existsSync(join(dir, 'poll-heartbeat.json'))).toBe(false)
  })

  test('the newest channel replaces the previous channel and keeps its pid on shutdown', async () => {
    const dir = state()
    const first = start(dir, fixture.argv)
    await first.ready()
    await until(() => calls(dir).some(call => call.method === 'getUpdates'))
    const previous = readFileSync(join(dir, 'bot.pid'), 'utf8')
    const second = start(dir, fixture.argv)
    await second.ready()
    await until(() => first.child.exitCode !== null)
    await until(() => existsSync(join(dir, 'poll-heartbeat.json')) &&
      JSON.parse(readFileSync(join(dir, 'poll-heartbeat.json'), 'utf8')).pid === Number(readFileSync(join(dir, 'bot.pid'), 'utf8')))
    expect(readFileSync(join(dir, 'bot.pid'), 'utf8')).not.toBe(previous)
    expect(second.stderr()).toContain(`replacing stale poller pid=${previous}`)
    expect(second.child.exitCode).toBeNull()
    await second.close()
    expect(existsSync(join(dir, 'bot.pid'))).toBe(false)
  })

  test('a channel replaces an orphan holder, but leaves an unrelated recycled pid alive', async () => {
    const dir = state()
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'server.ts'])
    children.push(orphan)
    writeFileSync(join(dir, 'bot.pid'), String(orphan.pid))
    const channel = start(dir, fixture.argv)
    await channel.ready()
    await until(() => orphan.signalCode === 'SIGTERM')
    expect(channel.stderr()).toContain(`replacing stale poller pid=${orphan.pid}`)
    await channel.close()

    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    children.push(unrelated)
    writeFileSync(join(dir, 'bot.pid'), String(unrelated.pid))
    const restarted = start(dir, fixture.argv)
    await restarted.ready()
    await until(() => calls(dir).some(call => call.pid === Number(readFileSync(join(dir, 'bot.pid'), 'utf8')) && call.method === 'getUpdates'))
    expect(unrelated.signalCode).toBeNull()
    expect(restarted.stderr()).not.toContain('replacing stale poller')
    await restarted.close()
    unrelated.kill('SIGTERM')
    await until(() => unrelated.signalCode === 'SIGTERM')
  })
})
