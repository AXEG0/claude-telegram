import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ancestorPids, busyFiles, createTyping, markerFiles, readBusyAt, readTurnEnd, writeTurnEnd } from './typing.ts'

function harness(capMs = 60_000, chat?: string) {
  let t = 1_000
  let ended = 0
  let busy = 0
  const sent: string[] = []
  const capped: string[] = []
  const typing = createTyping({
    send: id => sent.push(id),
    turnEndedAt: () => ended,
    now: () => t,
    capMs,
    onCap: id => capped.push(id),
    busyAt: () => busy,
    chat: () => chat,
  })
  return {
    typing,
    sent,
    capped,
    advance(ms: number) { t += ms },
    endTurn() { ended = t },
    work() { busy = t },
  }
}

describe('createTyping', () => {
  test('types at once and on every tick until the turn ends', () => {
    const h = harness()
    h.typing.start('42')
    h.advance(4000); h.typing.tick()
    h.advance(4000); h.typing.tick()
    expect(h.sent).toEqual(['42', '42', '42'])

    h.endTurn()
    h.advance(4000); h.typing.tick()
    expect(h.sent.length).toBe(3)
    expect(h.typing.active()).toEqual([])
  })

  test('a turn that ended before the message keeps it typing', () => {
    const h = harness()
    h.endTurn()
    h.advance(10)
    h.typing.start('42')
    h.advance(4000); h.typing.tick()
    expect(h.sent).toEqual(['42', '42'])
  })

  test('stops at the cap when no turn end arrives, and says so once', () => {
    const h = harness(10_000)
    h.typing.start('42')
    h.advance(10_000); h.typing.tick()
    h.advance(4000); h.typing.tick()
    expect(h.sent).toEqual(['42'])
    expect(h.capped).toEqual(['42'])
    expect(h.typing.active()).toEqual([])
  })

  test('a turn that ends sends no stuck notice', () => {
    const h = harness(10_000)
    h.typing.start('42')
    h.advance(9_000); h.endTurn()
    h.advance(2_000); h.typing.tick()
    expect(h.capped).toEqual([])
  })

  test('a pause holds typing but keeps the chat, and resume brings it back', () => {
    const h = harness()
    h.typing.start('42')
    h.typing.pause()
    h.advance(4000); h.typing.tick()
    expect(h.sent).toEqual(['42'])
    expect(h.typing.active()).toEqual(['42'])

    h.typing.resume()
    h.advance(4000); h.typing.tick()
    expect(h.sent).toEqual(['42', '42'])
  })

  test('a pause ends with the turn, so the next message types', () => {
    const h = harness()
    h.typing.start('42')
    h.typing.pause()
    h.endTurn()
    h.advance(1); h.typing.tick()
    h.typing.start('42')
    expect(h.sent).toEqual(['42', '42'])
  })

  test('time paused on a permission prompt does not count toward the cap', () => {
    const h = harness(10_000)
    h.typing.start('42')
    h.advance(5_000)
    h.typing.pause()
    h.advance(60_000); h.typing.tick()
    expect(h.capped).toEqual([])
    h.typing.resume()
    h.advance(4_000); h.typing.tick()
    expect(h.capped).toEqual([])
    expect(h.sent).toEqual(['42', '42'])
    h.advance(2_000); h.typing.tick()
    expect(h.capped).toEqual(['42'])
  })

  test('a pause with no chat typing does not hold the next message', () => {
    const h = harness()
    h.typing.pause()
    h.typing.start('42')
    h.advance(4000); h.typing.tick()
    expect(h.sent).toEqual(['42', '42'])
  })
})

describe('typing for a turn no message started', () => {
  test('types into the last chat while the session is busy, until the turn ends', () => {
    const h = harness(60_000, '42')
    h.work()
    h.advance(100); h.typing.tick()
    h.advance(4000); h.work(); h.typing.tick()
    expect(h.sent).toEqual(['42', '42'])
    h.advance(1000); h.endTurn()
    h.advance(4000); h.typing.tick()
    expect(h.sent.length).toBe(2)
    expect(h.typing.active()).toEqual([])
  })

  test('activity from before the last turn end starts nothing', () => {
    const h = harness(60_000, '42')
    h.work(); h.advance(10); h.endTurn()
    h.advance(4000); h.typing.tick()
    expect(h.sent).toEqual([])
  })

  test('the cap counts from the last activity', () => {
    const h = harness(10_000, '42')
    h.work(); h.typing.tick()
    for (let i = 0; i < 5; i++) { h.advance(4000); h.work(); h.typing.tick() }
    expect(h.capped).toEqual([])
    h.advance(10_000); h.typing.tick()
    expect(h.capped).toEqual(['42'])
  })

  test('nothing without a chat', () => {
    const h = harness(60_000)
    h.work(); h.advance(10); h.typing.tick()
    expect(h.sent).toEqual([])
  })
})

describe('turn-end markers', () => {
  test('one file per session id and per Claude Code pid', () => {
    expect(markerFiles('/s', 'abc-123', [4242, 99])).toEqual(['/s/turns/session-abc-123', '/s/turns/pid-4242', '/s/turns/pid-99'])
    expect(markerFiles('/s', '../escape', [4242])).toEqual(['/s/turns/pid-4242'])
    expect(markerFiles('/s', undefined, [1])).toEqual([])
  })

  test('the ancestors start at the given pid and include its parent', () => {
    const pids = ancestorPids(process.pid)
    expect(pids[0]).toBe(process.pid)
    expect(pids[1]).toBe(process.ppid)
  })

  test('the latest end across the files is the turn end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typing-'))
    const [a, b] = markerFiles(dir, 'sess', [4242])
    expect(readTurnEnd([a!, b!])).toBe(0)
    writeTurnEnd([a!], 5)
    writeTurnEnd([b!], 9)
    expect(readTurnEnd([a!, b!])).toBe(9)
  })
})

describe('hooks/busy.sh', () => {
  const run = (env: Record<string, string>) => Bun.spawnSync(['sh', join(import.meta.dir, 'hooks', 'busy.sh')], {
    stdin: new TextEncoder().encode('{"hook_event_name":"PreToolUse"}'),
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env },
  })

  test('touches busy-<Claude Code pid>', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typing-'))
    expect(run({ TELEGRAM_STATE_DIR: dir, CLAUDE_PID: '4242' }).exitCode).toBe(0)
    expect(readBusyAt(busyFiles(dir, [4242]))).toBeGreaterThan(0)
  })

  test('without CLAUDE_PID it writes nothing and still exits 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typing-'))
    expect(run({ TELEGRAM_STATE_DIR: dir }).exitCode).toBe(0)
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('hooks/turn-end.ts', () => {
  function runHook(stdin: string, env: Record<string, string>) {
    return Bun.spawnSync(['bun', join(import.meta.dir, 'hooks', 'turn-end.ts')], {
      stdin: new TextEncoder().encode(stdin),
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env },
    })
  }

  test('writes the end time for the session id and the pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typing-'))
    const before = Date.now()
    const r = runHook(JSON.stringify({ session_id: 'sess-1', hook_event_name: 'Stop' }), {
      TELEGRAM_STATE_DIR: dir,
      CLAUDE_PID: '4242',
    })
    expect(r.exitCode).toBe(0)
    expect(readdirSync(join(dir, 'turns')).sort()).toEqual(['pid-4242', 'session-sess-1'])
    expect(Number(readFileSync(join(dir, 'turns', 'session-sess-1'), 'utf8'))).toBeGreaterThanOrEqual(before)
  })

  test('exits 0 on input it cannot read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typing-'))
    const r = runHook('not json', { TELEGRAM_STATE_DIR: dir, CLAUDE_PID: '4242' })
    expect(r.exitCode).toBe(0)
    expect(readdirSync(join(dir, 'turns'))).toEqual(['pid-4242'])
  })
})
