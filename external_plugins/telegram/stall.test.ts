// The record of the session's sends whose outcome is unknown, what closes it,
// the event it ends with and the probe (stall.ts), on clocks the tests give.
// The running server's part is in stall.integration.test.ts.
import { afterEach, describe, expect, jest, test } from 'bun:test'
import { createStall, entryText, eventText, isAnswer, isWrite, PROBE_MS, STALL_EVENT, type Entry, type Settled } from './stall.ts'
import { inStall, stallVerdict, UNKNOWN_EDIT, UNKNOWN_SEND } from './outcome.ts'

afterEach(() => { jest.useRealTimers() })

const T = Date.parse('2026-11-16T15:20:00.000Z')
// Another bot's username, as a reply to it goes: @ and its name.
const PEER = `@${'peer_eighty_bot'}`
const iso = (t: number) => new Date(t).toISOString()
const reply = (began: number, ended: number, extra: Partial<Entry> = {}): Entry =>
  ({ tool: 'reply', chat: '1', began, ended, words: 'hello there', ...extra })
// A call that settled at `at` after `ms`, answered as given.
const call = (method: string, ok: boolean | null, error_code?: number): Settled => ({ call: method, ms: 0, ok, ...(error_code !== undefined ? { error_code } : {}) })
const began = (s: Settled, start: number, at: number): [Settled, number] => [{ ...s, ms: at - start }, at]

function harness(o: { notify?: (content: string, meta: Record<string, string>) => Promise<unknown>; probe?: () => Promise<unknown> } = {}) {
  const events: { content: string; meta: Record<string, string> }[] = []
  const lines: string[] = []
  const probes: number[] = []
  const stall = createStall({
    notify: o.notify ?? (async (content, meta) => { events.push({ content, meta }) }),
    probe: o.probe ?? (async () => { probes.push(Date.now()) }),
    log: line => lines.push(line),
  })
  return { stall, events, lines, probes }
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

describe('which calls count', () => {
  test('sends, edits, typing, reactions, a press\'s answer and setMyCommands are writes; polls and reads are not', () => {
    for (const m of ['sendMessage', 'sendRichMessage', 'sendPhoto', 'sendDocument', 'sendMediaGroup', 'sendChatAction', 'editMessageText', 'editMessageCaption', 'editMessageReplyMarkup', 'setMessageReaction', 'answerCallbackQuery', 'setMyCommands']) {
      expect([m, isWrite(m)]).toEqual([m, true])
    }
    for (const m of ['getUpdates', 'getMe', 'getFile', 'getChat', 'getChatMember', 'deleteWebhook', 'sender', 'edit']) {
      expect([m, isWrite(m)]).toEqual([m, false])
    }
  })

  test('an answer is ok, or a refusal below 500; a 500 and no answer are none', () => {
    expect(isAnswer(call('sendMessage', true))).toBe(true)
    expect(isAnswer(call('sendMessage', false, 400))).toBe(true)
    expect(isAnswer(call('sendMessage', false, 429))).toBe(true)
    expect(isAnswer(call('sendMessage', false, 499))).toBe(true)
    expect(isAnswer(call('sendMessage', false, 500))).toBe(false)
    expect(isAnswer(call('sendMessage', false, 502))).toBe(false)
    expect(isAnswer(call('sendMessage', null))).toBe(false)
    expect(isAnswer({ call: 'sendMessage', ms: 0, ok: false })).toBe(false)
  })
})

describe('the record', () => {
  test('opens on the first unknown send, which sets since, and closes on the first answered write begun after its end, not at it', async () => {
    const { stall, events, lines } = harness()
    expect(stall.unknown(reply(T, T + 16_000))).toBe(T)
    expect(lines).toEqual([`stall opened: ${JSON.stringify({ since: iso(T), by: { tool: 'reply', chat: '1', began: iso(T), ended: iso(T + 16_000), words: 'hello there', line: `chat 1, began ${iso(T)}, "hello there"` } })}`])
    // Begun exactly at the end: no close.
    stall.settled(...began(call('sendChatAction', true), T + 16_000, T + 17_000))
    await settle()
    expect(events).toHaveLength(0)
    stall.settled(...began(call('sendChatAction', true), T + 16_001, T + 18_000))
    await settle()
    expect(events).toHaveLength(1)
    expect(events[0]!.meta).toEqual({ event: STALL_EVENT, since: iso(T), until: iso(T + 18_000) })
    expect(events[0]!.content).toBe(eventText([reply(T, T + 16_000)], T, T + 18_000))
    stall.stop()
  })

  test('a read, a poll, a 5xx and an unanswered write never close it; a refusal below 500 does', async () => {
    const { stall, events } = harness()
    stall.unknown(reply(T, T + 1000))
    for (const s of [call('getChat', true), call('getChatMember', true), call('getMe', true), call('getFile', true), call('getUpdates', true), call('sendMessage', false, 500), call('sendMessage', false, 502), call('sendMessage', null)]) {
      stall.settled(...began(s, T + 2000, T + 3000))
    }
    await settle()
    expect(events).toHaveLength(0)
    stall.settled(...began(call('setMessageReaction', false, 400), T + 2000, T + 3000))
    await settle()
    expect(events.map(e => e.meta.until)).toEqual([iso(T + 3000)])
    stall.stop()
  })

  test('a send that began before the opener and joins later moves since to its start, and a write begun before its end does not close the record', async () => {
    const { stall, events } = harness()
    expect(stall.unknown(reply(T + 5000, T + 21_000))).toBe(T + 5000)
    // Waited for a 504 from before the opener, and ended after it.
    expect(stall.unknown(reply(T, T + 120_000, { words: 'the long one' }))).toBe(T)
    stall.settled(...began(call('sendChatAction', true), T + 22_000, T + 23_000))
    await settle()
    expect(events).toHaveLength(0)
    stall.settled(...began(call('sendChatAction', true), T + 120_001, T + 121_000))
    await settle()
    expect(events).toHaveLength(1)
    expect(events[0]!.meta.since).toBe(iso(T))
    expect(events[0]!.content).toContain('"hello there"')
    expect(events[0]!.content).toContain('"the long one"')
    stall.stop()
  })

  test('a send that ends unknown after the close opens a new record with its own event', async () => {
    const { stall, events, lines } = harness()
    stall.unknown(reply(T, T + 1000))
    stall.settled(...began(call('sendMessage', true), T + 2000, T + 3000))
    // Still waiting at the close, then unknown.
    stall.unknown(reply(T + 1500, T + 4000, { words: 'second' }))
    stall.settled(...began(call('sendMessage', true), T + 5000, T + 6000))
    await settle()
    expect(events.map(e => [e.meta.since, e.meta.until])).toEqual([[iso(T), iso(T + 3000)], [iso(T + 1500), iso(T + 6000)]])
    expect(events[0]!.content).not.toContain('second')
    expect(events[1]!.content).toContain('"second"')
    expect(lines.filter(l => l.startsWith('stall opened: '))).toHaveLength(2)
    expect(lines.filter(l => l.startsWith('stall closed: '))).toHaveLength(2)
    stall.stop()
  })

  test('the close line goes once the event is handed, with since, until, the closing write, whether it was the probe and each entry with its line', async () => {
    let hand: () => void = () => {}
    const { stall, lines } = harness({ notify: () => new Promise<void>(r => { hand = r }) })
    const e = reply(T, T + 1000, { copy: '/state/logs/text-1.jsonl' })
    stall.unknown(e)
    stall.settled(...began(call('editMessageText', true), T + 2000, T + 2500))
    await settle()
    expect(lines.filter(l => l.startsWith('stall closed: '))).toHaveLength(0)
    hand()
    await settle()
    const closed = lines.filter(l => l.startsWith('stall closed: '))
    expect(closed).toHaveLength(1)
    expect(JSON.parse(closed[0]!.slice('stall closed: '.length))).toEqual({
      since: iso(T), until: iso(T + 2500), closed_by: 'editMessageText', probe: false,
      entries: [{ ...e, began: iso(T), ended: iso(T + 1000), line: entryText(e) }],
    })
    stall.stop()
  })

  test('an event Claude Code\'s pipe refuses leaves a line saying so, with the record', async () => {
    const { stall, lines } = harness({ notify: () => Promise.reject(new Error('pipe closed')) })
    stall.unknown(reply(T, T + 1000))
    stall.settled(...began(call('sendMessage', true), T + 2000, T + 2500))
    await settle()
    expect(lines.filter(l => l.startsWith('stall closed: '))).toHaveLength(0)
    expect(lines.filter(l => l.startsWith('stall event not handed to Claude (pipe closed): '))).toHaveLength(1)
    stall.stop()
  })
})

describe('the event', () => {
  test('says when Telegram left the sends unanswered and answered again, warns of held messages a day back, and says until is no end for them', () => {
    const text = eventText([reply(T, T + 1000)], T, T + 60_000)
    expect(text.split('\n')[0]).toBe(
      `Telegram left these sends of this bot unanswered from ${iso(T)} and answered a write begun after them at ${iso(T + 60_000)}. ` +
      "Telegram says it keeps a bot's updates up to 24 hours and gives no sign when a message it held will come, so messages sent to this bot in the 24 hours before this note may still arrive, each with its own send time; " +
      `${iso(T + 60_000)} is when Telegram answered this bot's writes again, not when messages to it stopped waiting.`)
  })

  test('names a person\'s send under To people, a bot\'s under To bots with its @username, a card under Cards and an edit under Edits by its chat_id, and shows only lines with entries', () => {
    const person = reply(T, T + 1000, { words: 'to the owner', copy: '/state/logs/text-9.jsonl', part: 2, total: 3, never: '3' })
    const bot = reply(T + 1, T + 1000, { chat: '7080', bot: PEER, words: 'to a peer' })
    const card = reply(T + 2, T + 1000, { words: 'Merge?', card: true })
    const edit: Entry = { tool: 'edit_message', chat: '7080', message: 100, began: T + 3, ended: T + 1000 }
    const lines = eventText([person, bot, card, edit], T, T + 2000).split('\n')
    expect(lines.slice(1)).toEqual([
      `To people, delivery unknown: chat 1, began ${iso(T)}, "to the owner", saved copy /state/logs/text-9.jsonl, part 2 of 3, parts never tried: 3. Send again what still matters, its first line saying it may repeat an earlier message; for what went stale, send a short note that it replaces any earlier copy.`,
      `To bots, delivery unknown: chat 7080, ${PEER}, began ${iso(T + 1)}, "to a peer". Ask that bot whether it arrived, and send it again only if it says no.`,
      `Cards, delivery unknown: chat 1, began ${iso(T + 2)}, "Merge?". Its buttons still count if it arrived. If a press on it has reached you, there is nothing to send. Otherwise, if it went stale, send a short note that it replaces any earlier copy; if it still matters, send its text again without buttons, its first line saying it may repeat an earlier message, and ask for the answer in words or on the earlier copy's buttons. If its reader says the earlier copy never came, send it again with buttons, as today.`,
      `Edits, outcome unknown: chat 7080, message 100, began ${iso(T + 3)}. Repeat each as it stands.`,
    ])
    expect(eventText([edit], T, T + 2000).split('\n').slice(1).map(l => l.split(':')[0])).toEqual(['Edits, outcome unknown'])
    expect(eventText([bot], T, T + 2000).split('\n').slice(1).map(l => l.split(':')[0])).toEqual(['To bots, delivery unknown'])
    expect(eventText([card, person], T, T + 2000).split('\n').slice(1).map(l => l.split(':')[0])).toEqual(['To people, delivery unknown', 'Cards, delivery unknown'])
  })

  test('two entries on one line are each named, a reply of one part names no part, and the last part names none never tried', () => {
    expect(entryText(reply(T, T + 1, { total: 1, part: 1, never: 'none' }))).toBe(`chat 1, began ${iso(T)}, "hello there"`)
    expect(entryText(reply(T, T + 1, { total: 2, part: 2, never: 'none' }))).toBe(`chat 1, began ${iso(T)}, "hello there", part 2 of 2, parts never tried: none`)
    const line = eventText([reply(T, T + 1, { words: 'one' }), reply(T + 5, T + 6, { words: 'two' })], T, T + 10).split('\n')[1]!
    expect(line).toStartWith(`To people, delivery unknown: chat 1, began ${iso(T)}, "one"; chat 1, began ${iso(T + 5)}, "two". `)
  })
})

describe('the subagents message\'s wait', () => {
  test('settles on the first answered write begun after its send ended, never on a read, a 5xx or a write begun at its end', async () => {
    const { stall } = harness()
    let settled = false
    void stall.after(T + 1000).then(() => { settled = true })
    stall.settled(...began(call('getChat', true), T + 2000, T + 2100))
    stall.settled(...began(call('sendMessage', false, 502), T + 2000, T + 2100))
    stall.settled(...began(call('sendChatAction', true), T + 1000, T + 2100))
    await settle()
    expect(settled).toBe(false)
    stall.settled(...began(call('sendChatAction', true), T + 1001, T + 2100))
    await settle()
    expect(settled).toBe(true)
    stall.stop()
  })
})

describe('the probe', () => {
  test('goes a minute after the record opens and a minute after each probe settles, until a write closes the record, and its answer closing it says so', async () => {
    jest.useFakeTimers({ now: T })
    let answer: (() => void) | undefined
    const probes: number[] = []
    const { stall, lines, events } = harness({ probe: () => { probes.push(Date.now()); return new Promise<void>((resolve, reject) => { answer = resolve; setTimeout(() => reject(new Error('no answer within 30 s')), 30_000) }) } })
    stall.unknown(reply(T - 16_000, T))
    expect(PROBE_MS).toBe(60_000)
    jest.advanceTimersByTime(59_999)
    expect(probes).toEqual([])
    jest.advanceTimersByTime(1)
    expect(probes).toEqual([T + 60_000])
    // Never answered: fails at 30 s, and the next goes a minute later.
    jest.advanceTimersByTime(30_000)
    await settle()
    jest.advanceTimersByTime(59_999)
    expect(probes).toEqual([T + 60_000])
    jest.advanceTimersByTime(1)
    expect(probes).toEqual([T + 60_000, T + 150_000])
    // Answered: the probe's own write closes the record.
    stall.settled({ call: 'setMyCommands', ms: 200, ok: true }, Date.now() + 200)
    answer!()
    await settle()
    expect(events).toHaveLength(1)
    expect(JSON.parse(lines.find(l => l.startsWith('stall closed: '))!.slice('stall closed: '.length))).toMatchObject({ closed_by: 'setMyCommands', probe: true })
    jest.advanceTimersByTime(10 * PROBE_MS)
    expect(probes).toHaveLength(2)
    stall.stop()
  })

  test('runs while the subagents message waits, stops once nothing waits, and setMyCommands from elsewhere is not the probe', async () => {
    jest.useFakeTimers({ now: T })
    const { stall, probes, lines } = harness()
    void stall.after(T)
    jest.advanceTimersByTime(PROBE_MS)
    expect(probes).toEqual([T + PROBE_MS])
    stall.settled({ call: 'sendChatAction', ms: 0, ok: true }, Date.now())
    await settle()
    jest.advanceTimersByTime(5 * PROBE_MS)
    expect(probes).toHaveLength(1)
    // Not probing: polling start's own setMyCommands closes as a plain write.
    stall.unknown(reply(Date.now() - 1000, Date.now()))
    stall.settled({ call: 'setMyCommands', ms: 0, ok: true }, Date.now() + 1)
    await settle()
    expect(JSON.parse(lines.find(l => l.startsWith('stall closed: '))!.slice('stall closed: '.length))).toMatchObject({ closed_by: 'setMyCommands', probe: false })
    stall.stop()
  })

  test('none goes once stopped', () => {
    jest.useFakeTimers({ now: T })
    const { stall, probes } = harness()
    stall.unknown(reply(T - 1000, T))
    stall.stop()
    jest.advanceTimersByTime(5 * PROBE_MS)
    expect(probes).toEqual([])
  })
})

describe('the result of an unknown send inside the record', () => {
  test('replaces today\'s verdict with the record\'s, a send\'s and an edit\'s, and names none for a result that names no unknown outcome', () => {
    const since = iso(T)
    expect(stallVerdict(since)).toBe(`delivery unknown: Telegram has left this bot's sends unanswered since ${since}; do not send it again yet: once Telegram answers a write again, one event names this send and says what to do`)
    expect(stallVerdict(since, true)).toBe(`edit outcome unknown: Telegram has left this bot's sends unanswered since ${since}; do not send it again yet: once Telegram answers a write again, one event names this send and says what to do`)
    expect(inStall(`part 2 of 3: ${UNKNOWN_SEND} (Telegram answered 502: Bad Gateway); sent so far: 1 message(s) (ids: 100); never tried: part 3`, since))
      .toBe(`part 2 of 3: ${stallVerdict(since)} (Telegram answered 502: Bad Gateway); sent so far: 1 message(s) (ids: 100); never tried: part 3`)
    expect(inStall(`${UNKNOWN_EDIT} (Telegram did not answer within 10 s)`, since)).toBe(`${stallVerdict(since, true)} (Telegram did not answer within 10 s)`)
    expect(inStall('not sent (Telegram answered 403: Forbidden)', since)).toBeUndefined()
    expect(inStall('the text was edited, but the buttons could not be set again', since)).toBeUndefined()
  })
})
