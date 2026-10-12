import { describe, expect, test } from 'bun:test'
import { alertConfig, createIdleAlarm, duration, idleText, IDLE_MINUTES, RECOVERED_TEXT, STUCK_MINUTES, stuckText } from './alerts.ts'
import { PROMPT_GRACE_MS } from './typing.ts'

const MIN = 60_000

describe('alertConfig', () => {
  test('a 10-minute stuck notice and no idle alert unless set', () => {
    expect(STUCK_MINUTES).toBe(10)
    expect(alertConfig({})).toEqual({ capMs: 10 * MIN, warnings: [] })
  })

  test('an alert chat turns on the idle alert at 45 minutes', () => {
    expect(IDLE_MINUTES).toBe(45)
    expect(alertConfig({ TELEGRAM_ALERT_CHAT: ' 64024129 ' })).toEqual({
      capMs: 10 * MIN, idle: { chat: '64024129', ms: 45 * MIN }, warnings: [],
    })
    expect(alertConfig({ TELEGRAM_ALERT_CHAT: '-1001234' }).idle?.chat).toBe('-1001234')
  })

  test('both times take minutes, fractions included', () => {
    const c = alertConfig({ TELEGRAM_STUCK_MINUTES: '15', TELEGRAM_ALERT_CHAT: '1', TELEGRAM_ALERT_IDLE_MINUTES: '0.5' })
    expect(c).toEqual({ capMs: 15 * MIN, idle: { chat: '1', ms: 30_000 }, warnings: [] })
  })

  test('the idle time alone turns nothing on', () => {
    expect(alertConfig({ TELEGRAM_ALERT_IDLE_MINUTES: '45' }).idle).toBeUndefined()
  })

  test('a value it cannot use falls back and says so', () => {
    for (const bad of ['0', '-3', 'ten', 'Infinity']) {
      const c = alertConfig({ TELEGRAM_STUCK_MINUTES: bad, TELEGRAM_ALERT_CHAT: '1', TELEGRAM_ALERT_IDLE_MINUTES: bad })
      expect(c.capMs).toBe(10 * MIN)
      expect(c.idle?.ms).toBe(45 * MIN)
      expect(c.warnings).toHaveLength(2)
    }
  })

  test('an alert chat that is not a chat id leaves the idle alert off and says so', () => {
    const c = alertConfig({ TELEGRAM_ALERT_CHAT: '@owner' })
    expect(c.idle).toBeUndefined()
    expect(c.warnings[0]).toContain('TELEGRAM_ALERT_CHAT')
  })
})

describe('the messages', () => {
  test('name the time the settings give', () => {
    expect(stuckText(10 * MIN)).toBe('⚠️ No turn end seen in 10 minutes: Claude may be stuck, or was interrupted. Typing has stopped.')
    expect(idleText(45 * MIN)).toBe('⚠️ No activity in this Claude Code session for 45 minutes: no prompt, tool call or turn end. It may be stuck.')
    expect(RECOVERED_TEXT).toBe('✅ Back to normal: Claude is active again.')
  })

  test('durations read as people say them', () => {
    expect(duration(MIN)).toBe('1 minute')
    expect(duration(90 * MIN)).toBe('90 minutes')
    expect(duration(30_000)).toBe('30 seconds')
    expect(duration(1000)).toBe('1 second')
    expect(duration(200)).toBe('1 second')
  })
})

function alarm(idleMs = 45 * MIN) {
  let t = 1_000_000
  let activity = 0
  const events: string[] = []
  const a = createIdleAlarm({
    activityAt: () => activity,
    idleMs,
    onIdle: () => events.push('idle'),
    onRecover: () => events.push('back'),
    now: () => t,
  })
  return {
    a,
    events,
    advance(ms: number) { t += ms; a.tick() },
    work() { activity = t },
  }
}

describe('createIdleAlarm', () => {
  test('counts from its own start, so a session with no activity yet waits the full time', () => {
    const h = alarm()
    h.advance(45 * MIN - 1)
    expect(h.events).toEqual([])
    h.advance(1)
    expect(h.events).toEqual(['idle'])
  })

  test('activity restarts the clock', () => {
    const h = alarm()
    h.advance(40 * MIN); h.work()
    h.advance(40 * MIN)
    expect(h.events).toEqual([])
    h.advance(5 * MIN)
    expect(h.events).toEqual(['idle'])
  })

  test('alerts once per silence, and activity after it reports Claude back once', () => {
    const h = alarm()
    h.advance(45 * MIN)
    h.advance(60 * MIN)
    expect(h.events).toEqual(['idle'])
    h.advance(1000); h.work()
    h.advance(4000)
    h.advance(4000)
    expect(h.events).toEqual(['idle', 'back'])
    h.advance(45 * MIN)
    expect(h.events).toEqual(['idle', 'back', 'idle'])
  })

  test('time a permission prompt waits does not count', () => {
    const h = alarm()
    h.advance(30 * MIN)
    h.a.pause()
    h.advance(120 * MIN)
    expect(h.events).toEqual([])
  })

  test('an answer in Telegram restarts the clock from the answer', () => {
    const h = alarm()
    h.advance(30 * MIN)
    h.a.pause()
    h.advance(60 * MIN)
    h.a.resume()
    h.advance(45 * MIN - 1)
    expect(h.events).toEqual([])
    h.advance(1)
    expect(h.events).toEqual(['idle'])
  })

  test('activity past the grace ends the pause, an answer in the terminal', () => {
    const h = alarm()
    h.advance(30 * MIN)
    h.a.pause()
    h.advance(PROMPT_GRACE_MS)
    h.work()
    h.advance(10 * MIN)
    h.work()
    h.advance(45 * MIN)
    expect(h.events).toEqual(['idle'])
  })

  test('activity inside the grace is the prompt\'s own and keeps the pause', () => {
    const h = alarm()
    h.advance(30 * MIN)
    h.a.pause()
    h.work()
    h.advance(120 * MIN)
    expect(h.events).toEqual([])
  })
})
