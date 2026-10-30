// The production server in a subprocess, under a process named claude, with
// only Telegram's HTTP replaced offline by telegram-preload.ts. Shared by the
// integration tests; these tests never use the owner's bot.
import { setSystemTime } from 'bun:test'
import { spawn, type ChildProcess } from 'child_process'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CHAT_GAP_MS, CLOSING_EDIT_MS } from '../agents.ts'

// The longest a server takes to exit once its input closes: its closing edit
// of the subagents message may wait for the chat's next slot first.
export const EXIT_MS = CHAT_GAP_MS + CLOSING_EDIT_MS + 1000

export const children: ChildProcess[] = []
const dirs: string[] = []

export function state(access: object = { dmPolicy: 'allowlist', allowFrom: ['1'] }): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-polling-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'access.json'), JSON.stringify(access))
  return dir
}

// A test on the driven clock (driveClock()) and its servers share one
// timeline: the servers' fake timers (fixtures/clock.ts) and this process's
// Date.now(), pinned to it. Time on it moves only while the test waits, in
// moves of STEP_MS, so the test sees what happened at most one move late,
// while each server's timers fire at their own due times.
export const STEP_MS = 100
let timeline: number | undefined
let advances = 0
// Each test's waits belong to it: once it ends, a wait it left running moves
// no clock.
let epoch = 0
const driven = new Set<ChildProcess>()
export function driveClock(): void {
  epoch++
  timeline = Date.now()
  setSystemTime(new Date(timeline))
}
// A wait's limit counts every move of the clock made while it waits, by any
// wait of the test, and holds in real time too, as the timers it replaced did.
type Watch = { epoch: number; from: number; realFrom: number }
const watch = (): Watch => ({ epoch, from: timeline!, realFrom: performance.now() })
// A wait left running by a test that has ended, such as one past Bun's limit
// per test, fails saying so before any limit is read.
const LEFT_OVER = 'the test that started this wait has ended; this wait is left over from it'
function leftOver(w: Watch): void { if (w.epoch !== epoch) throw new Error(LEFT_OVER) }
const onClock = (w: Watch) => (timeline ?? Infinity) - w.from
const inReal = (w: Watch) => performance.now() - w.realFrom
function serverPidOf(child: ChildProcess): number | undefined {
  try { return Number(readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8').trim().split(' ')[0]) || undefined } catch { return undefined }
}
function clockOf(dir: string, pid: number): { n: number; now: number } | undefined {
  try { return JSON.parse(readFileSync(join(dir, 'clock', `${pid}.now`), 'utf8')) } catch { return undefined }
}
const dirOf = new Map<ChildProcess, string>()
// Moves every running server of the test, and this process's clock, ms on.
// Each server moves to the same time, so one that started while the clock was
// moving catches up. With no server to move, the clock stays and real time
// passes instead. Waits that run at once, such as two tool calls, take turns
// moving it.
let driving: Promise<boolean> | undefined
async function drive(ms: number, w: Watch): Promise<boolean> {
  while (driving) await driving
  leftOver(w)
  driving = driveOnce(ms)
  try { return await driving } finally { driving = undefined }
}
// Every process under this one: the test's servers, their claude stand-ins
// and any helper the test spawned.
function descendants(): number[] {
  const found: number[] = []
  const walk = (pid: number) => {
    let threads: string[] = []
    try { threads = readdirSync(`/proc/${pid}/task`) } catch { return }
    for (const thread of threads) {
      let kids = ''
      try { kids = readFileSync(`/proc/${pid}/task/${thread}/children`, 'utf8').trim() } catch {}
      for (const kid of kids ? kids.split(' ').map(Number) : []) { found.push(kid); walk(kid) }
    }
  }
  walk(process.pid)
  return found
}
// Whether any thread of those processes runs or waits on the disk.
function working(): boolean {
  for (const pid of descendants()) {
    let threads: string[] = []
    try { threads = readdirSync(`/proc/${pid}/task`) } catch { continue }
    for (const thread of threads) {
      let stat = ''
      try { stat = readFileSync(`/proc/${pid}/task/${thread}/stat`, 'utf8') } catch { continue }
      const state = stat[stat.lastIndexOf(')') + 2]
      if (state === 'R' || state === 'D') return true
    }
  }
  return false
}
// Real work, such as a server's parsing worker or a helper still starting,
// ends before the clock moves, so a timer on the test's clock never runs out
// while work it bounds is still running in real time. Once a check finds
// work, the clock waits for two idle checks in a row.
async function idle(): Promise<void> {
  if (!working()) return
  const end = performance.now() + 30_000
  for (let idle = 0; idle < 2;) {
    if (performance.now() > end) throw new Error('a process of the test kept working for 30 s, so the clock could not move')
    await Bun.sleep(1)
    idle = working() ? 0 : idle + 1
  }
}
// What a server that did not move shows: each thread's name, state and
// kernel wait, the signals pending, blocked and caught, its clock files, and
// the end of its error output.
const stderrOf = new Map<ChildProcess, () => string>()
function read(path: string): string { try { return readFileSync(path, 'utf8') } catch (err) { return `(${(err as Error).message})` } }
function field(status: string, name: string): string { return status.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'))?.[1] ?? '?' }
function snapshot(child: ChildProcess, dir: string, pid: number): string {
  const status = read(`/proc/${pid}/status`)
  const lines = [`server ${pid}: ShdPnd ${field(status, 'ShdPnd')} SigCgt ${field(status, 'SigCgt')} SigIgn ${field(status, 'SigIgn')}`]
  let threads: string[] = []
  try { threads = readdirSync(`/proc/${pid}/task`) } catch {}
  for (const tid of threads) {
    const t = read(`/proc/${pid}/task/${tid}/status`)
    lines.push(`  thread ${tid} ${field(t, 'Name')} ${field(t, 'State')} wchan=${read(`/proc/${pid}/task/${tid}/wchan`)} SigPnd ${field(t, 'SigPnd')} SigBlk ${field(t, 'SigBlk')} syscall=${read(`/proc/${pid}/task/${tid}/syscall`).trim()}`)
  }
  lines.push(`  request ${read(join(dir, 'clock', String(pid)))}; now ${read(join(dir, 'clock', `${pid}.now`))}`)
  lines.push(`  stderr: ${(stderrOf.get(child)?.() ?? '').slice(-2000)}`)
  return lines.join('\n')
}
// What the test wrote to a server, a request, a notification or the end of
// its input, reaches the server some time after the write, and Bun calls the
// write's callback before it has. A move that starts before the server has
// taken it up moves the server's clock past the time the test wrote it. The
// clock waits until each server has taken all of it, by what the server's
// clock reports (fixtures/clock.ts), so the server reads it at the time the
// test wrote it, and the check for real work that follows sees the server
// take it up. A server that exits, or an input that fails, holds nothing back.
type Owed = { pid: number; written: number; ending: boolean } | undefined
const owedBy = new Map<ChildProcess, () => Owed>()
function inputOf(dir: string, pid: number): { bytes: number; ended: boolean } {
  try { return JSON.parse(readFileSync(join(dir, 'clock', `${pid}.input`), 'utf8')) } catch { return { bytes: 0, ended: false } }
}
function owing(child: ChildProcess): Owed {
  const owed = owedBy.get(child)?.()
  if (!owed) return undefined
  const input = inputOf(dirOf.get(child)!, owed.pid)
  return input.bytes < owed.written || (owed.ending && !input.ended) ? owed : undefined
}
async function taken(live: () => ChildProcess[]): Promise<void> {
  const end = performance.now() + 30_000
  for (;;) {
    const waiting = live().filter(c => owing(c) !== undefined)
    if (waiting.length === 0) return
    if (performance.now() > end) {
      throw new Error(`a server did not take up what the test wrote to it within 30 s\n${waiting.map(c => {
        const { pid, written, ending } = owing(c) ?? { pid: 0, written: 0, ending: false }
        const input = inputOf(dirOf.get(c)!, pid)
        return `server ${pid}: written ${written} bytes${ending ? ' and the end' : ''}, taken ${input.bytes}${input.ended ? ' and the end' : ''}\n${snapshot(c, dirOf.get(c)!, pid)}`
      }).join('\n')}`)
    }
    await Bun.sleep(1)
  }
}
async function driveOnce(ms: number): Promise<boolean> {
  // A server still starting has no clock yet. The timeline waits for it, so
  // every server of the test stays on the same time.
  const live = () => [...driven].filter(c => c.exitCode === null && c.signalCode === null)
  const started = (c: ChildProcess) => { const pid = serverPidOf(c); return pid !== undefined && clockOf(dirOf.get(c)!, pid) !== undefined }
  const booting = performance.now() + 30_000
  while (live().some(c => !started(c))) {
    if (performance.now() > booting) throw new Error('a server did not start its clock')
    await Bun.sleep(5)
  }
  await taken(live)
  await idle()
  const n = ++advances
  const moving: [string, number, ChildProcess][] = []
  for (const child of live()) {
    const pid = serverPidOf(child)
    const dir = dirOf.get(child)!
    if (pid === undefined || clockOf(dir, pid) === undefined) continue
    writeFileSync(join(dir, 'clock', String(pid)), JSON.stringify({ n, to: timeline! + ms }))
    try { process.kill(pid, 'SIGUSR2'); moving.push([dir, pid, child]) } catch {}
  }
  if (moving.length === 0) { await Bun.sleep(10); return false }
  const end = performance.now() + 30_000
  const stalled = () => moving.filter(([dir, pid]) => clockOf(dir, pid)?.n !== n && existsSync(`/proc/${pid}`))
  while (stalled().length) {
    if (performance.now() > end) throw new Error(`a server did not move its clock\n${stalled().map(([dir, pid, child]) => snapshot(child, dir, pid)).join('\n')}`)
    await Bun.sleep(1)
  }
  timeline! += ms
  setSystemTime(new Date(timeline!))
  return true
}
export const onDrivenClock = () => timeline !== undefined

// Lets ms pass: on the driven clock by moving it, otherwise in real time.
export async function wait(ms: number): Promise<void> {
  if (timeline === undefined) return Bun.sleep(ms)
  const w = watch()
  while (leftOver(w), onClock(w) < ms) {
    if (!(await drive(Math.min(STEP_MS, ms - onClock(w)), w)) && ![...driven].some(c => c.exitCode === null && c.signalCode === null)) return
  }
}
// Gives a file the test wrote the time on the test's clock, as a file the
// server reads the time of would have if written at that moment.
export function stamp(path: string): void {
  utimesSync(path, Date.now() / 1000, Date.now() / 1000)
}

export async function until(check: () => boolean, timeout = 4000): Promise<void> {
  if (timeline !== undefined) {
    const w = watch()
    for (;;) {
      leftOver(w)
      if (inReal(w) > timeout) throw new Error('subprocess did not reach expected state within the limit in real time')
      if (check()) break
      if (onClock(w) > timeout) throw new Error('subprocess did not reach expected state')
      await drive(STEP_MS, w)
    }
    // What the test does next comes after what it waited for, as it would in
    // real time, never at the same instant.
    await drive(1, w)
    return
  }
  const end = Date.now() + timeout
  while (!check()) {
    if (Date.now() > end) throw new Error('subprocess did not reach expected state')
    await Bun.sleep(10)
  }
}

export type Call = { pid: number; method: string; payload: any; at: number; message_id?: number; refused?: string; started?: number[]; taken?: string[]; aborted?: boolean; failed?: string; answered?: string }
// Each call the fake logged. A line not yet ended is still being written,
// and is read once it is.
export function calls(dir: string): Call[] {
  const file = join(dir, 'api.jsonl')
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line))
}

// Telegram's answer to a poll while another poller holds the bot, and the
// environment that makes the fake give it, by the fake's rules.
export const CONFLICT = { error_code: 409, description: 'Conflict: terminated by other getUpdates request' }
export const conflicts = (rules: object[]) => ({ TELEGRAM_TEST_RULES: JSON.stringify(rules) })
// The gaps between the server's polls, in milliseconds, by the fake's log.
export const pollGaps = (dir: string) => calls(dir).filter(c => c.method === 'getUpdates').map((c, i, all) => i ? c.at - all[i - 1]!.at : 0).slice(1)
// Each gap within slack of its seconds reads as those seconds; one outside
// reads as its milliseconds.
export const asSeconds = (gaps: number[], seconds: number[], slack: number) =>
  gaps.map((gap, i) => Math.abs(gap - (seconds[i] ?? 0) * 1000) <= slack ? seconds[i] : gap)

// A round of updates for the next getUpdates, written whole before the fake
// can read it.
export function deliver(dir: string, updates: object[]): void {
  const file = join(dir, 'inbound.json')
  writeFileSync(`${file}.tmp`, JSON.stringify(updates.map((u, i) => ({ update_id: i + 1, ...u }))))
  renameSync(`${file}.tmp`, file)
}

// What a call past its limit on the test's clock shows: each call that reached
// the fake Telegram in the test's state folder since the call was sent, with
// when it came on the clock from then and the server that made it, and each
// server's polls as a count and when the last came.
function callsSince(dir: string, from: number, self: number | undefined): string {
  const who = (pid: number) => `server ${pid}${pid === self ? ' (this call\'s)' : ''}`
  const lines: string[] = []
  const polls = new Map<number, { n: number; last: number }>()
  for (const c of calls(dir)) {
    if (c.at < from) continue
    if (c.method === 'getUpdates') {
      const p = polls.get(c.pid) ?? { n: 0, last: 0 }
      polls.set(c.pid, { n: p.n + 1, last: c.at - from })
      continue
    }
    const message = c.payload?.message_id !== undefined ? ` message ${c.payload.message_id}` : ''
    lines.push(`  ${c.at - from} ms: ${who(c.pid)} ${c.method}${message}${c.refused ? `, which the fake refuses: ${c.refused}` : ''}`)
  }
  for (const [pid, p] of polls) lines.push(`  ${who(pid)}: ${p.n} polls, the last at ${p.last} ms`)
  return lines.length ? lines.join('\n') : '  none'
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
      ...(timeline !== undefined ? { TELEGRAM_TEST_CLOCK_NOW: String(timeline) } : {}),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  if (timeline !== undefined) { driven.add(child); dirOf.set(child, dir) }
  // Each write counts its bytes, and the end of the input counts once, for
  // the server to take up before the clock moves; an input that fails, or a
  // server that exits, holds nothing back.
  let written = 0, ending = false, failed = false
  const input = child.stdin
  const write = input.write.bind(input), finish = input.end.bind(input)
  const bytes = (chunk: unknown, encoding: unknown) => typeof chunk === 'string'
    ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8')
    : (chunk as Uint8Array).byteLength
  input.write = ((chunk: unknown, ...rest: unknown[]) => {
    written += bytes(chunk, rest[0])
    return write(chunk as never, ...(rest as []))
  }) as typeof input.write
  input.end = ((...args: unknown[]) => {
    if (args[0] != null && typeof args[0] !== 'function') written += bytes(args[0], args[1])
    ending = true
    return finish(...(args as []))
  }) as typeof input.end
  input.on('error', () => { failed = true })
  owedBy.set(child, () => {
    if (failed || child.exitCode !== null || child.signalCode !== null || (written === 0 && !ending)) return undefined
    const pid = serverPidOf(child)
    return pid === undefined ? undefined : { pid, written, ending }
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  stderrOf.set(child, () => stderr)
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
      const timer = timeline === undefined ? setTimeout(() => reject(new Error(`${method} timed out: ${stderr}`)), timeout) : undefined
      replies.set(next, value => { clearTimeout(timer); resolve(value) })
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n')
    if (timeline === undefined) return response
    // On the driven clock the answer may wait on the server's timers, so time
    // moves until it comes. It must come within the limit on the test's clock
    // and within the same limit in real time.
    const w = watch()
    let came: { clock: number; real: number } | undefined
    const mark = () => { came = { clock: onClock(w), real: inReal(w) } }
    response.then(mark, mark)
    while (!came && (leftOver(w), onClock(w) <= timeout && inReal(w) <= timeout)) await drive(STEP_MS, w)
    if (came && came.real <= timeout && came.clock <= timeout) return response
    leftOver(w)
    if ((came?.real ?? inReal(w)) > timeout) return Promise.reject(new Error(`${method} timed out in real time: ${stderr}`))
    return Promise.reject(new Error(`${method} timed out on the test's clock: ${stderr}\nTelegram calls since it was sent, by when each reached the fake on the test's clock:\n${callsSince(dir, w.from, serverPidOf(child))}`))
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
    async close() { child.stdin.end(); await until(() => child.exitCode !== null, EXIT_MS) },
    // The production server's own pid: the one child of the process named claude.
    serverPid: () => Number(readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8').trim().split(' ')[0]),
    exited: () => child.exitCode !== null || child.signalCode !== null,
  }
}
export type Server = ReturnType<typeof start>

// Ends with SIGKILL every production server a test left running on its state
// folder, read from the fake's log and checked by that folder in its
// environment: a server whose broken output kept it from exiting would
// otherwise outlive the test.
export function killServers(dir: string): void {
  for (const pid of new Set(calls(dir).map(c => c.pid))) {
    let env = ''
    try { env = readFileSync(`/proc/${pid}/environ`, 'utf8') } catch { continue }
    if (!env.split('\0').includes(`TELEGRAM_STATE_DIR=${dir}`)) continue
    try { process.kill(pid, 'SIGKILL') } catch {}
  }
}

// Each test file runs this after each test: it ends the servers the test
// started and removes their state folders.
export async function cleanup(): Promise<void> {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin?.end()
      try {
        await until(() => child.exitCode !== null || child.signalCode !== null, EXIT_MS)
      } catch {
        child.kill('SIGKILL')
      }
    }
  }
  for (const dir of dirs) killServers(dir)
  for (const dir of dirs.splice(0)) {
    // A test may leave its state folder read-only.
    try { chmodSync(dir, 0o700) } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
  driven.clear()
  dirOf.clear()
  owedBy.clear()
  stderrOf.clear()
  epoch++
  if (timeline !== undefined) { timeline = undefined; setSystemTime() }
}
