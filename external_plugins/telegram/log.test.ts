// The writer, run in a child process on a temporary state folder, so the test
// runner's own stderr and console stay untouched.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const CHILD = join(import.meta.dir, 'fixtures', 'log-child.ts')
// The server log's bound, 1 MiB.
const SERVER_BOUND = 1024 * 1024
const VERSION = JSON.parse(readFileSync(join(import.meta.dir, '.claude-plugin', 'plugin.json'), 'utf8')).version
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'log-test-')); dirs.push(d); return d }

async function run(dir: string, kase: string) {
  const p = Bun.spawn([process.execPath, CHILD, dir, kase], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_STT_OPENAI_KEY: undefined } })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { pid: p.pid, out, err, code }
}
const read = (f: string) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
const records = (f: string) => read(f).split('\n').filter(Boolean).map(l => JSON.parse(l))
const count = (text: string, part: string) => text.split(part).length - 1
const logFile = (dir: string, pid: number) => join(dir, 'logs', `server-${pid}.jsonl`)
const callFile = (dir: string, pid: number) => join(dir, 'logs', `calls-${pid}.jsonl`)

describe('the writer', () => {
  test('each kind of line lands once in the file and once on stderr', async () => {
    const dir = fresh()
    const r = await run(dir, 'lines')
    expect(r.code).toBe(0)
    const recs = records(logFile(dir, r.pid))
    const file = recs.map(x => x.log).join('\n')
    for (const part of [
      'telegram channel: a direct line',
      'telegram channel: a computed name',
      'telegram channel: an error: Error: boom',
      "FATAL: grammY unable to handle: GrammyError: Call to 'sendMessage' failed! (400: Bad Request: refused)",
      'telegram channel: a console.warn line',
      'Error: 100%s done',
      `(node:${r.pid}) Warning: a direct warning`,
      `(node:${r.pid}) [MY_CODE] Warning: a coded warning`,
      `(node:${r.pid}) TimeoutOverflowWarning:`,
      `(node:${r.pid}) MaxListenersExceededWarning:`,
    ]) {
      expect([part, count(file, part)]).toEqual([part, 1])
      expect([part, count(r.err, part)]).toEqual([part, 1])
    }
    // Each warning's own words, whatever a printer wraps them in: Bun 1.3's
    // native print has no "(node:<pid>)", so only these count a second print.
    for (const words of ['a direct warning', 'a coded warning', "the coded warning's detail", 'does not fit into a 32-bit signed integer', '11 leak listeners added']) {
      expect([words, count(r.err, words)]).toEqual([words, 1])
      expect([words, count(file, words)]).toEqual([words, 1])
    }
    // A warning prints Bun 1.4's --trace-warnings text: its head, its frames, its detail.
    const coded = recs.find(x => x.log.includes('[MY_CODE] Warning: a coded warning'))!.log.split('\n')
    expect(coded[0]).toBe(`(node:${r.pid}) [MY_CODE] Warning: a coded warning`)
    expect(coded.slice(1, -1).length).toBeGreaterThan(0)
    expect(coded.slice(1, -1).every((l: string) => /^\s+at /.test(l))).toBe(true)
    expect(coded.at(-1)).toBe("the coded warning's detail")
    const leak = recs.find(x => x.log.includes('MaxListenersExceededWarning'))!.log.split('\n')
    expect(leak.length).toBeGreaterThan(1)
    expect(leak.slice(1).every((l: string) => /^\s+at /.test(l))).toBe(true)
    expect(recs.find(x => x.log.startsWith('Error: 100%s done'))!.log).toEndWith(' and the next argument')
    for (const x of recs) expect(x).toMatchObject({ pid: r.pid, version: VERSION })
    expect(recs.every(x => !Number.isNaN(Date.parse(x.at)))).toBe(true)
  })

  test("an error prints its name, message and frames, never its own fields", async () => {
    const dir = fresh()
    const r = await run(dir, 'lines')
    const file = read(logFile(dir, r.pid))
    for (const text of [file, r.err]) {
      expect(text).not.toContain('MARKER-MESSAGE-TEXT')
      expect(text).not.toContain('payload')
    }
    const boom = records(logFile(dir, r.pid)).find(x => x.log.includes('Error: boom'))!.log
    expect(boom.split('\n').slice(1).every((l: string) => /^\s+at /.test(l))).toBe(true)
    expect(boom.split('\n').length).toBeGreaterThan(1)
  })

  test('the file is 0600 in a 0700 folder', async () => {
    const dir = fresh()
    const r = await run(dir, 'lines')
    expect(statSync(join(dir, 'logs')).mode & 0o777).toBe(0o700)
    expect(statSync(logFile(dir, r.pid)).mode & 0o777).toBe(0o600)
  })

  test('importing the writer changes nothing', async () => {
    const dir = fresh()
    const base = Bun.spawnSync([process.execPath, '-e', "process.stdout.write(JSON.stringify({ write: process.stderr.write.name, error: console.error.name, listeners: process.listenerCount('warning') }))"])
    const r = await run(dir, 'import')
    expect(JSON.parse(r.out)).toEqual({ ...JSON.parse(base.stdout.toString()), logs: false })
  })

  test('with no state folder a line goes to stderr only and no folder is made', async () => {
    const dir = join(fresh(), 'missing')
    const r = await run(dir, 'nostate')
    expect(r.err).toContain('telegram channel: no state folder')
    expect(existsSync(dir)).toBe(false)
  })

  test("a reused pid's file rotates by its real size", async () => {
    const dir = fresh()
    const r = await run(dir, 'reused')
    const f = logFile(dir, r.pid)
    expect(read(`${f}.1`)).toContain('after a reused pid')
    expect(records(f).map(x => x.log)).toEqual(['telegram channel: the next line'])
    expect(statSync(f).size).toBeLessThan(SERVER_BOUND)
  })

  test('a rename that fails leaves the record whole and the next one on its own line', async () => {
    const dir = fresh()
    const r = await run(dir, 'rotate-fails')
    const lines = read(logFile(dir, r.pid)).split('\n')
    expect(lines.slice(1)).toHaveLength(3)
    expect(lines.slice(1).map(l => (l ? JSON.parse(l).log : ''))).toEqual(['telegram channel: X', 'telegram channel: Y', ''])
  })

  test('after a failed append the next record starts on a new line, once', async () => {
    const dir = fresh()
    const r = await run(dir, 'ragged')
    const lines = read(logFile(dir, r.pid)).split('\n')
    expect(lines.map(l => (l ? JSON.parse(l).log : ''))).toEqual(['telegram channel: A', '', 'telegram channel: C', 'telegram channel: D', ''])
    expect(r.err).toContain('telegram channel: B')
  })

  test('a deleted folder is made again, a deleted state folder is not', async () => {
    const dir = fresh()
    const r = await run(dir, 'gone')
    expect(JSON.parse(r.out)).toEqual(['telegram channel: B'])
    expect(existsSync(dir)).toBe(false)
    for (const part of ['A', 'B', 'C']) expect(r.err).toContain(`telegram channel: ${part}\n`)
  })

  test('lines after stderr is gone still land, with no spin', async () => {
    const dir = fresh()
    const p = Bun.spawn([process.execPath, CHILD, dir, 'far-end'], { stdout: 'ignore', stderr: 'pipe', env: { ...process.env, TELEGRAM_BOT_TOKEN: undefined } })
    const reader = p.stderr.getReader()
    await reader.read()
    await reader.cancel()
    const t0 = Date.now()
    expect(await p.exited).toBe(0)
    expect(Date.now() - t0).toBeLessThan(10000)
    const cpu = JSON.parse(read(join(dir, 'cpu.json')))
    expect((cpu.user + cpu.system) / 1000).toBeLessThan(1500)
    expect(records(logFile(dir, p.pid)).map(x => x.log)).toEqual([
      'telegram channel: before the far end goes',
      'telegram channel: after the far end went, 1',
      'telegram channel: after the far end went, 2',
      'telegram channel: unhandled rejection: Error: rejected',
      'telegram channel: uncaught exception: Error: boom',
      'telegram channel: shutting down',
    ])
  }, 15000)
})

describe('the call record', () => {
  test('a call line lands in its own file with the envelope, 0600, never in the server log and never on stderr', async () => {
    const dir = fresh()
    const r = await run(dir, 'calls')
    expect(r.code).toBe(0)
    const recs = records(callFile(dir, r.pid))
    expect(recs).toEqual([{ at: expect.any(String), pid: r.pid, version: VERSION, call: 'sendMessage', chat: '1', ms: 5, ok: true, message_id: 7 }])
    expect(Number.isNaN(Date.parse(recs[0].at))).toBe(false)
    expect(statSync(callFile(dir, r.pid)).mode & 0o777).toBe(0o600)
    expect(existsSync(logFile(dir, r.pid))).toBe(false)
    expect(r.err).toBe('')
  })

  test('each file keeps its own bound: the call file moves to .1 past 16 MiB, the server log past 1 MiB', async () => {
    const dir = fresh()
    const r = await run(dir, 'call-bounds')
    expect(JSON.parse(r.out)).toEqual({
      past: { calls: true, moved: false },
      atBound: { calls: false, moved: true },
      server: { server: false, moved: true },
    })
  })

  test('a call line that cannot be written is counted, and the next line that lands carries lost once', async () => {
    const dir = fresh()
    const r = await run(dir, 'calls-lost')
    expect(records(callFile(dir, r.pid)).map(x => [x.call, x.lost])).toEqual([['b', 1], ['c', undefined]])
    expect(r.err).toBe('')
  })

  test('before setup a call line is written nowhere', async () => {
    const dir = fresh()
    const r = await run(dir, 'call-before-setup')
    expect(JSON.parse(r.out)).toEqual({ logs: false })
    expect(r.err).toBe('')
    expect(readdirSync(dir)).toEqual([])
  })
})
