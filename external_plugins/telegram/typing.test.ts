import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTyping, markerFiles, readTurnEnd, writeTurnEnd } from './typing.ts'

function harness(capMs = 60_000) {
  let t = 1_000
  let ended = 0
  const sent: string[] = []
  const typing = createTyping({
    send: id => sent.push(id),
    turnEndedAt: () => ended,
    now: () => t,
    capMs,
  })
  return {
    typing,
    sent,
    advance(ms: number) { t += ms },
    endTurn() { ended = t },
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

  test('stops at the cap when no turn end arrives', () => {
    const h = harness(10_000)
    h.typing.start('42')
    h.advance(10_000); h.typing.tick()
    expect(h.sent).toEqual(['42'])
    expect(h.typing.active()).toEqual([])
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
})

describe('turn-end markers', () => {
  test('one file per session id and per Claude Code pid', () => {
    expect(markerFiles('/s', 'abc-123', 4242)).toEqual(['/s/turns/session-abc-123', '/s/turns/pid-4242'])
    expect(markerFiles('/s', '../escape', 4242)).toEqual(['/s/turns/pid-4242'])
    expect(markerFiles('/s', undefined, 1)).toEqual([])
  })

  test('the latest end across the files is the turn end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typing-'))
    const [a, b] = markerFiles(dir, 'sess', 4242)
    expect(readTurnEnd([a!, b!])).toBe(0)
    writeTurnEnd([a!], 5)
    writeTurnEnd([b!], 9)
    expect(readTurnEnd([a!, b!])).toBe(9)
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
