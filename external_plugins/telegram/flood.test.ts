import { describe, expect, test } from 'bun:test'
import { chatKey, createHolds, FLOOD_LINE, floodTransformer, type Holds } from './flood.ts'

const T0 = Date.UTC(2026, 9, 30, 9, 5, 44)
const TOO_MANY = (n?: number) => ({
  ok: false, error_code: 429, description: `Too Many Requests: retry after ${n}`,
  ...(n === undefined ? {} : { parameters: { retry_after: n } }),
})

// A watch on a fake call that answers as given, with its log lines and holds.
function watched(answer: object, o: { holds?: Holds; log?: (line: string) => void } = {}) {
  let t = T0
  const now = () => t
  const holds = o.holds ?? createHolds(now)
  const lines: string[] = []
  const transform = floodTransformer({ holds, log: o.log ?? (line => { lines.push(line) }), now })
  const call = (method: string, payload: object) =>
    transform(async () => answer as { ok: boolean }, method, payload)
  return { call, holds, lines, advance: (ms: number) => { t += ms }, now }
}

describe('the flood watch', () => {
  test('a 429 with retry_after on a call to a chat writes one line and holds that chat until the wait ends', async () => {
    const w = watched(TOO_MANY(1262))
    const answer = await w.call('sendMessage', { chat_id: '1', text: 'hello' })
    expect(answer).toEqual(TOO_MANY(1262))
    expect(w.lines).toEqual([
      `${FLOOD_LINE}sendMessage to chat 1: 429, retry after 1262 s, held until 09:26:46 UTC (Telegram: Too Many Requests: retry after 1262)`,
    ])
    expect(w.holds.until('1')).toBe(T0 + 1262_000)
    expect(w.holds.held('1')).toBe(true)
    expect(w.holds.held('2')).toBe(false)
  })

  test('a call without a chat writes its line with no chat and holds nothing', async () => {
    const w = watched(TOO_MANY(5))
    await w.call('getUpdates', { offset: 3, timeout: 30 })
    await w.call('answerCallbackQuery', { callback_query_id: 'q1' })
    expect(w.lines).toEqual([
      `${FLOOD_LINE}getUpdates to no chat: 429, retry after 5 s, nothing held (Telegram: Too Many Requests: retry after 5)`,
      `${FLOOD_LINE}answerCallbackQuery to no chat: 429, retry after 5 s, nothing held (Telegram: Too Many Requests: retry after 5)`,
    ])
    for (const chat of ['', 'undefined', 'q1', '3']) expect(w.holds.held(chat)).toBe(false)
  })

  test('a 429 without retry_after says so and holds nothing', async () => {
    const w = watched({ ok: false, error_code: 429, description: 'Too Many Requests' })
    await w.call('sendChatAction', { chat_id: 1, action: 'typing' })
    expect(w.lines).toEqual([`${FLOOD_LINE}sendChatAction to chat 1: 429, no retry_after given, nothing held (Telegram: Too Many Requests)`])
    expect(w.holds.held('1')).toBe(false)
  })

  test('an answer other than a 429 writes no line and holds nothing, even one that carries a numeric retry_after', async () => {
    const refused = watched({ ok: false, error_code: 400, description: 'Bad Request: chat not found', parameters: { retry_after: 5 } })
    await refused.call('sendMessage', { chat_id: '1', text: 'hello' })
    expect(refused.holds.held('1')).toBe(false)
    expect(refused.lines).toEqual([])
    const accepted = watched({ ok: true, result: { message_id: 7 }, parameters: { retry_after: 5 } })
    await accepted.call('sendMessage', { chat_id: '1', text: 'hello' })
    expect(accepted.holds.held('1')).toBe(false)
    expect(accepted.lines).toEqual([])
  })

  test('a chat is held under the name the call gives, a @username in any case as one', async () => {
    const w = watched(TOO_MANY(30))
    await w.call('sendMediaGroup', { chat_id: '@Mixed_Case_Name', media: [] })
    expect(w.lines[0]).toStartWith(`${FLOOD_LINE}sendMediaGroup to chat @mixed_case_name: 429, retry after 30 s`)
    expect(w.holds.held('@mixed_case_name')).toBe(true)
    expect(w.holds.held('@MIXED_CASE_NAME')).toBe(true)
    expect(w.holds.held('7080')).toBe(false)
    await w.call('sendMessage', { chat_id: 5, text: 'x' })
    expect(w.holds.held('5')).toBe(true)
    expect(chatKey(undefined)).toBeUndefined()
    expect(chatKey('')).toBeUndefined()
    expect(chatKey(-100)).toBe('-100')
  })

  test('a longer wait extends a hold, and a shorter one never shortens it', async () => {
    let t = T0
    const holds = createHolds(() => t)
    expect(holds.hold('1', T0 + 30_000)).toBe(T0 + 30_000)
    expect(holds.hold('1', T0 + 60_000)).toBe(T0 + 60_000)
    expect(holds.until('1')).toBe(T0 + 60_000)
    t += 5_000
    expect(holds.hold('1', t + 20_000)).toBe(T0 + 60_000)
    expect(holds.until('1')).toBe(T0 + 60_000)
    // The watch's line names the hold's end, the later one.
    const w = watched(TOO_MANY(1249), { holds })
    w.advance(5_000)
    await w.call('sendMessage', { chat_id: '1', text: 'again' })
    expect(holds.until('1')).toBe(T0 + 5_000 + 1249_000)
    const short = watched(TOO_MANY(5), { holds })
    await short.call('sendMessage', { chat_id: '1', text: 'short' })
    expect(short.lines[0]).toEndWith('retry after 5 s, held until 09:26:38 UTC (Telegram: Too Many Requests: retry after 5)')
    expect(holds.until('1')).toBe(T0 + 5_000 + 1249_000)
  })

  test('a hold ends at its time, and a call that succeeds meanwhile does not end it', async () => {
    const w = watched(TOO_MANY(30))
    await w.call('sendMessage', { chat_id: '1', text: 'hello' })
    w.advance(29_999)
    expect(w.holds.held('1')).toBe(true)
    const ok = floodTransformer({ holds: w.holds, log: () => {}, now: w.now })
    await ok(async () => ({ ok: true }), 'sendMessage', { chat_id: '1' })
    expect(w.holds.held('1')).toBe(true)
    w.advance(1)
    expect(w.holds.held('1')).toBe(false)
    expect(w.holds.until('1')).toBe(0)
  })

  test('a log write that throws, or a record that throws, leaves the call\'s answer intact', async () => {
    const failingLog = watched(TOO_MANY(7), { log: () => { throw new Error('EPIPE: broken pipe, write') } })
    expect(await failingLog.call('sendMessage', { chat_id: '1', text: 'hello' })).toEqual(TOO_MANY(7))
    const broken: Holds = { until: () => 0, held: () => false, hold: () => { throw new Error('the record failed') } }
    const failingRecord = watched(TOO_MANY(7), { holds: broken })
    expect(await failingRecord.call('sendMessage', { chat_id: '1', text: 'hello' })).toEqual(TOO_MANY(7))
    // A call that fails outright fails as it would without the watch.
    const transform = floodTransformer({ holds: createHolds(), log: () => {} })
    const err = new Error('Network request failed')
    expect(transform(async () => { throw err }, 'sendMessage', { chat_id: '1' })).rejects.toBe(err)
  })
})
