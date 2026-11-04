import { describe, expect, test } from 'bun:test'
import { HttpError } from 'grammy'
import { type CallLine, chatKey, createHolds, FLOOD_LINE, floodTransformer, type Holds } from './flood.ts'

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
  const transform = floodTransformer({ holds, log: o.log ?? (line => { lines.push(line) }), record: () => {}, now })
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
    const ok = floodTransformer({ holds: w.holds, log: () => {}, record: () => {}, now: w.now })
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
    const transform = floodTransformer({ holds: createHolds(), log: () => {}, record: () => {} })
    const err = new Error('Network request failed')
    expect(transform(async () => { throw err }, 'sendMessage', { chat_id: '1' })).rejects.toBe(err)
  })
})

// The call record: the watch's line for each call, on a fake call that takes
// 250 ms and then answers as given, or throws.
const MARK = 'MARKER-q7Zt'
// The bot token in an error's text and URL; any text serves, so it is no
// token's shape.
const TOKEN = 'test-bot-token'
function recorded(answer: object | (() => never), o: { record?: (l: CallLine) => void; log?: (line: string) => void; holds?: Holds } = {}) {
  let t = T0
  const now = () => t
  const lines: CallLine[] = []
  const logLines: string[] = []
  const holds = o.holds ?? createHolds(now)
  const transform = floodTransformer({ holds, log: o.log ?? (l => { logLines.push(l) }), record: o.record ?? (l => { lines.push(l) }), now })
  const call = (method: string, payload: object) =>
    transform(async () => { t += 250; if (typeof answer === 'function') answer(); return answer as { ok: boolean } }, method, payload)
  return { call, lines, logLines, holds }
}

describe('the call record', () => {
  test("a send records its call, chat, time taken, outcome and the answer's message id", async () => {
    const w = recorded({ ok: true, result: { message_id: 77, chat: { id: 1 }, text: MARK } })
    await w.call('sendMessage', { chat_id: 1, text: MARK })
    expect(w.lines).toEqual([{ call: 'sendMessage', chat: '1', ms: 250, ok: true, message_id: 77 }])
  })

  test("an edit, a reaction and a keyboard change record the payload's message id; a silent send records silent", async () => {
    const w = recorded({ ok: true, result: true })
    await w.call('editMessageText', { chat_id: '1', message_id: 5, text: MARK })
    await w.call('setMessageReaction', { chat_id: '1', message_id: 6, reaction: [{ type: 'emoji', emoji: '👍' }] })
    await w.call('editMessageReplyMarkup', { chat_id: '1', message_id: 7, reply_markup: { inline_keyboard: [[{ text: MARK, callback_data: MARK }]] } })
    await w.call('sendMessage', { chat_id: '1', text: MARK, disable_notification: true })
    expect(w.lines.map(l => [l.call, l.message_id, l.silent])).toEqual([
      ['editMessageText', 5, undefined], ['setMessageReaction', 6, undefined], ['editMessageReplyMarkup', 7, undefined], ['sendMessage', undefined, true],
    ])
    expect(JSON.stringify(w.lines)).not.toContain(MARK)
  })

  test('an album records every id in order', async () => {
    const w = recorded({ ok: true, result: [{ message_id: 3 }, { message_id: 4 }, { message_id: 5 }] })
    await w.call('sendMediaGroup', { chat_id: '@Some_Peer', media: [] })
    expect(w.lines).toEqual([{ call: 'sendMediaGroup', chat: '@some_peer', ms: 250, ok: true, message_ids: [3, 4, 5] }])
  })

  test('a 429 records its code and wait, a 400 its code and whether the edit was unchanged, and neither its description; the hold and the line still happen', async () => {
    const w = recorded(TOO_MANY(28728))
    await w.call('sendMessage', { chat_id: '1', text: MARK })
    expect(w.lines).toEqual([{ call: 'sendMessage', chat: '1', ms: 250, ok: false, error_code: 429, retry_after: 28728 }])
    expect(w.logLines).toHaveLength(1)
    expect(w.holds.held('1')).toBe(true)
    const n = recorded({ ok: false, error_code: 400, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same' })
    await n.call('editMessageText', { chat_id: '1', message_id: 9, text: MARK })
    expect(n.lines).toEqual([{ call: 'editMessageText', chat: '1', ms: 250, ok: false, message_id: 9, error_code: 400, not_modified: true }])
    const q = recorded({ ok: false, error_code: 400, description: `Bad Request: can't parse entities: Unsupported start tag "${MARK}" at byte offset 0` })
    await q.call('sendMessage', { chat_id: '1', text: `<${MARK}>` })
    expect(JSON.stringify(q.lines)).not.toContain(MARK)
    expect(q.lines).toEqual([{ call: 'sendMessage', chat: '1', ms: 250, ok: false, error_code: 400 }])
  })

  test("a call that throws records no answer and the error's name, and its caller gets the very same error", async () => {
    const err = new HttpError(`Network request for 'sendMessage' failed! ${TOKEN} ${MARK}`, Object.assign(new TypeError(`Unable to connect https://api.telegram.org/bot${TOKEN}/sendMessage ${MARK}`), { code: 'ECONNREFUSED', path: `https://api.telegram.org/bot${TOKEN}` }))
    const w = recorded(() => { throw err })
    let caught: unknown
    try { await w.call('sendMessage', { chat_id: '1', text: MARK }) } catch (e) { caught = e }
    expect(caught).toBe(err)
    expect(w.lines).toEqual([{ call: 'sendMessage', chat: '1', ms: 250, ok: null, error: 'HttpError/ECONNREFUSED' }])
    // An abort keeps the fetch's error by its name.
    const aborted = recorded(() => { throw new HttpError("Network request for 'editMessageReplyMarkup' failed!", new DOMException('The operation was aborted.', 'AbortError')) })
    await aborted.call('editMessageReplyMarkup', { chat_id: '1', message_id: 3 }).catch(() => {})
    expect(aborted.lines).toEqual([{ call: 'editMessageReplyMarkup', chat: '1', ms: 250, ok: null, message_id: 3, error: 'HttpError/AbortError' }])
    // A name that holds text, outside or inside, reads unknown.
    const odd = recorded(() => { throw Object.assign(new Error('x'), { name: `${TOKEN} ${MARK}` }) })
    await odd.call('sendMessage', { chat_id: '1' }).catch(() => {})
    expect(odd.lines[0]!.error).toBe('unknown')
    const inner = recorded(() => { throw new HttpError('x', Object.assign(new Error(MARK), { name: `${TOKEN} ${MARK}`, code: `${MARK} 1` })) })
    await inner.call('sendMessage', { chat_id: '1' }).catch(() => {})
    expect(inner.lines[0]!.error).toBe('HttpError/unknown')
    expect(JSON.stringify([...w.lines, ...odd.lines, ...inner.lines])).not.toContain(MARK)
  })

  test('a poll records nothing; getMe records a line with no chat; a chat not shaped like an id or @username is left out', async () => {
    const w = recorded({ ok: true, result: [] })
    await w.call('getUpdates', { offset: 1, timeout: 30 })
    await w.call('getMe', {})
    await w.call('sendMessage', { chat_id: `hello ${MARK}`, text: MARK })
    expect(w.lines).toEqual([{ call: 'getMe', ms: 250, ok: true }, { call: 'sendMessage', ms: 250, ok: true }])
  })

  test('a record that throws leaves the answer, the hold and the flood line intact; a watch that throws still records', async () => {
    const w = recorded(TOO_MANY(7), { record: () => { throw new Error('ENOSPC') } })
    expect(await w.call('sendMessage', { chat_id: '1', text: 'x' })).toEqual(TOO_MANY(7))
    expect(w.logLines).toHaveLength(1)
    expect(w.holds.held('1')).toBe(true)
    const v = recorded(TOO_MANY(7), { log: () => { throw new Error('EPIPE') } })
    await v.call('sendMessage', { chat_id: '1', text: 'x' })
    expect(v.lines).toHaveLength(1)
  })
})

describe('the call record, by shape', () => {
  test('a call whose every field holds text or an out-of-shape number writes none of it', async () => {
    const send = recorded({ ok: true, result: { message_id: `${MARK}` } })
    await send.call(`send ${MARK}`, { chat_id: 1, message_id: `${MARK}`, disable_notification: `${MARK}` })
    const album = recorded({ ok: true, result: [{ message_id: 1 }, { message_id: `${MARK}` }] })
    await album.call('sendMediaGroup', { chat_id: 1 })
    const refused = recorded({ ok: false, error_code: `${MARK}`, description: MARK, parameters: { retry_after: `${MARK}` } })
    await refused.call('editMessageText', { chat_id: 1, message_id: 4 })
    expect(send.lines).toEqual([{ call: 'unknown', chat: '1', ms: 250, ok: true }])
    expect(album.lines).toEqual([{ call: 'sendMediaGroup', chat: '1', ms: 250, ok: true }])
    expect(refused.lines).toEqual([{ call: 'editMessageText', chat: '1', ms: 250, ok: false, message_id: 4 }])
    const odd = recorded({ ok: false, error_code: 1.5, parameters: { retry_after: Infinity } })
    await odd.call('sendMessage', { chat_id: 1, message_id: 2 ** 60 })
    expect(odd.lines).toEqual([{ call: 'sendMessage', chat: '1', ms: 250, ok: false }])
  })
})
