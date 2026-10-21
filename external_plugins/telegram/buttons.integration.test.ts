import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import fixture from './fixtures/channel-argv.json'
import { calls, cleanup, deliver, start, state, until, type Call, type Server } from './fixtures/harness.ts'
import { PASSING_LABELS, REFUSED_LABELS } from './fixtures/labels.ts'
import { CLOSED, lock, NOT_ON_MESSAGE, PRESS_AGAIN, RECORD_MAX } from './buttons.ts'
import { appendPermit, permitFile, permitText } from './permit.ts'
import { AGENT_TICK_MS, agentEventFile, appendAgentEvent } from './agents.ts'

afterEach(cleanup)

const OWNER = { id: 1, is_bot: false, first_name: 'Owner', username: 'owner' }
const DM = { id: 1, type: 'private' }
const SENDS = ['sendMessage', 'sendPhoto', 'sendDocument', 'sendRichMessage']
const EDITS = ['editMessageText', 'editMessageReplyMarkup']
const now = () => Math.floor(Date.now() / 1000)
const TOO_MANY = { error_code: 429, description: 'Too Many Requests: retry after 5', parameters: { retry_after: 5 } }
const REJECTED = { error_code: 400, description: 'Bad Request: RICH_MESSAGE_MARKDOWN_INVALID' }
const NOT_MODIFIED = { error_code: 400, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message' }

type Options = { ids?: number; rules?: object[]; chats?: object; env?: Record<string, string> }
const envOf = (o: Options) => ({
  TELEGRAM_TEST_CHATS: JSON.stringify({ ids: o.ids ?? 100, ...o.chats }),
  TELEGRAM_TEST_RULES: JSON.stringify(o.rules ?? []),
  ...o.env,
})
// The channel server, polling, its messages numbered from ids.
async function channel(dir: string, o: Options = {}): Promise<Server> {
  const srv = start(dir, fixture.argv, envOf(o))
  await srv.ready()
  await until(() => srv.stderr().includes('polling as '), 6000)
  return srv
}
// The server of a session that does not poll, on the same state folder.
async function sender(dir: string, o: Options = {}): Promise<Server> {
  const srv = start(dir, ['claude', '-p', 'hello'], envOf({ ids: 900, ...o }))
  await srv.ready()
  return srv
}

const tool = async (srv: Server, name: string, args: object, timeout?: number) =>
  (await srv.request('tools/call', { name, arguments: args }, timeout)).result
const ok = (r: any): string => {
  if (r.isError) throw new Error(`tool failed: ${r.content[0].text}`)
  return r.content[0].text
}
const failed = (r: any): string => {
  expect(r.isError).toBe(true)
  return r.content[0].text
}
// Sends text with buttons to the owner and returns the id of the message
// carrying them.
async function ask(srv: Server, text = 'Merge now?', buttons: string[][] = [['Yes', 'No']], extra: object = {}): Promise<number> {
  const result = ok(await tool(srv, 'reply', { chat_id: '1', text, buttons, ...extra }))
  return Number(/; buttons on message (\d+)$/.exec(result)![1])
}

const markupOf = (c: Call) => typeof c.payload.reply_markup === 'string' ? JSON.parse(c.payload.reply_markup) : c.payload.reply_markup
// The keyboard a message shows now, by the fake's log: the send that gave it
// its id, then every edit Telegram took.
function shown(dir: string, message: number, chat = '1'): any {
  let markup: any
  for (const c of calls(dir)) {
    if (c.refused || String(c.payload.chat_id) !== chat) continue
    if (SENDS.includes(c.method) && c.message_id === message) markup = markupOf(c)
    if (EDITS.includes(c.method) && c.payload.message_id === message) markup = markupOf(c)
  }
  return markup
}
const chosen = (label: string) => ({ inline_keyboard: [[{ text: label, disabled: {} }]] })
const dataOf = (markup: any, label: string): string => markup.inline_keyboard.flat().find((b: any) => b.text === label).callback_data

// A press on the button labelled label, as Telegram returns it: with the
// keyboard the message shows now in the fake's log, unless markup says what
// Telegram returns instead (null: no keyboard).
let seq = 0
function press(dir: string, message: number, label: string, o: { from?: object; chat?: { id: number; type: string }; markup?: any; text?: string; data?: string } = {}) {
  const chat = o.chat ?? DM
  const markup = o.markup === undefined ? shown(dir, message, String(chat.id)) : o.markup
  const data = o.data ?? dataOf(markup, label)
  const id = `cb${++seq}`
  return {
    id,
    update: { callback_query: { id, chat_instance: 'c', data, from: o.from ?? OWNER, message: {
      message_id: message, date: now(), chat,
      ...(o.text !== undefined ? { text: o.text } : {}),
      ...(markup ? { reply_markup: markup } : {}),
    } } },
  }
}
const answers = (dir: string) =>
  Object.fromEntries(calls(dir).filter(c => c.method === 'answerCallbackQuery').map(c => [c.payload.callback_query_id, c.payload.text ?? null]))
async function answerTo(dir: string, id: string): Promise<string | null> {
  await until(() => id in answers(dir), 6000)
  return answers(dir)[id]
}
const pressed = (srv: Server) => srv.inbound().filter(n => n.meta.button !== undefined)
const record = (dir: string) => JSON.parse(readFileSync(join(dir, 'buttons.json'), 'utf8'))
const entryOf = (dir: string, message: number, chat = '1') => record(dir).entries.find((e: any) => e.chat === chat && e.message === message)
const swaps = (dir: string, message: number) =>
  calls(dir).filter(c => c.method === 'editMessageReplyMarkup' && c.payload.message_id === message && JSON.stringify(c.payload.reply_markup ?? {}).includes('disabled'))
const serverPid = (dir: string) => Number(readFileSync(join(dir, 'bot.pid'), 'utf8'))

describe.skipIf(process.platform !== 'linux')('answer buttons in the running server', () => {
  // Criterion 1: reply.

  test('reply puts the keyboard on the last message it sends, a text part or a file, in every format, and names that message', async () => {
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1'], textChunkLimit: 10 })
    mkdirSync(join(dir, 'inbox'))
    writeFileSync(join(dir, 'inbox', 'chart.png'), 'png')
    writeFileSync(join(dir, 'inbox', 'notes.txt'), 'notes')
    const srv = await channel(dir, { env: { TELEGRAM_RICH_MESSAGES: 'true' } })
    const sendsSince = (from: number) => calls(dir).slice(from).filter(c => SENDS.includes(c.method))
    const cases: [object, string[], string][] = [
      [{ text: 'a'.repeat(10) + 'b'.repeat(10), format: 'text' }, ['sendMessage', 'sendMessage'], 'sent 2 parts (ids: 100, 101); buttons on message 101'],
      [{ text: '*Merge?*', format: 'markdownv2' }, ['sendMessage'], 'sent (id: 102); buttons on message 102'],
      [{ text: '**Merge?**' }, ['sendRichMessage'], 'sent (id: 103); buttons on message 103'],
      [{ text: 'the files', format: 'text', files: [join(dir, 'inbox', 'chart.png'), join(dir, 'inbox', 'notes.txt')] }, ['sendMessage', 'sendPhoto', 'sendDocument'], 'sent 3 parts (ids: 104, 105, 106); buttons on message 106'],
      [{ text: '**the chart**', files: [join(dir, 'inbox', 'chart.png')] }, ['sendRichMessage', 'sendPhoto'], 'sent 2 parts (ids: 107, 108); buttons on message 108'],
    ]
    for (const [args, methods, result] of cases) {
      const from = calls(dir).length
      expect(ok(await tool(srv, 'reply', { chat_id: '1', buttons: [['Yes', 'No']], ...args }))).toBe(result)
      const sent = sendsSince(from)
      // Each message goes once, and only the last carries the keyboard.
      expect(sent.map(c => c.method)).toEqual(methods)
      expect(sent.slice(0, -1).map(markupOf)).toEqual(sent.slice(0, -1).map(() => undefined))
      const carrier = sent.at(-1)!
      expect(markupOf(carrier).inline_keyboard.map((row: any[]) => row.map(b => b.text))).toEqual([['Yes', 'No']])
      expect(Number(/(\d+)$/.exec(result)![1])).toBe(carrier.message_id!)
    }
    // Without buttons, a reply returns what it always did.
    expect(ok(await tool(srv, 'reply', { chat_id: '1', text: 'plain', format: 'text' }))).toBe('sent (id: 109)')
    expect(markupOf(calls(dir).findLast(c => c.method === 'sendMessage')!)).toBeUndefined()
    await srv.close()
  }, 20000)

  test('each button’s data is the prefix, an id from the record’s counter and its index, new for every keyboard, on the same message and after a restart', async () => {
    const dir = state()
    const first = await channel(dir)
    const before = Date.now()
    const m = await ask(first, 'Pick one', [['A', 'B'], ['C']])
    const keyboard = (message: number) => shown(dir, message).inline_keyboard.flat().map((b: any) => b.callback_data)
    const k1 = Number(/^btn:(\d+):0$/.exec(keyboard(m)[0])![1])
    expect(keyboard(m)).toEqual([`btn:${k1}:0`, `btn:${k1}:1`, `btn:${k1}:2`])
    // A new record counts from the clock's milliseconds.
    expect(k1).toBeGreaterThanOrEqual(before - 60_000)
    expect(k1).toBeLessThanOrEqual(Date.now())
    expect(record(dir).next).toBe(k1 + 1)
    ok(await tool(first, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['A', 'B'], ['C']] }))
    expect(keyboard(m)).toEqual([`btn:${k1 + 1}:0`, `btn:${k1 + 1}:1`, `btn:${k1 + 1}:2`])
    await first.close()
    const second = await channel(dir, { ids: 200 })
    const m2 = await ask(second, 'Again', [['A']])
    expect(keyboard(m2)).toEqual([`btn:${k1 + 2}:0`])
    for (const data of [...keyboard(m), ...keyboard(m2)]) expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
    await second.close()
  }, 20000)

  test('reply and edit_message refuse each label, row or set past the limits before any call, and labels that pass come back unchanged in the press event', async () => {
    const dir = state()
    const srv = await channel(dir)
    const before = calls(dir).length
    const row = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `b${from + i}`)
    const refused: unknown[] = [
      ...REFUSED_LABELS.map(([, label]) => [[label]]),
      [], [[]], [row(5)], [row(1), row(1, 1), row(1, 2), row(1, 3), row(1, 4)], [['Yes'], ['No', 'Yes']], 'Yes',
    ]
    for (const buttons of refused) {
      expect(failed(await tool(srv, 'reply', { chat_id: '1', text: 'Q', buttons }))).toMatch(/^reply failed: (button label|buttons must be)/)
      if (Array.isArray(buttons) && buttons.length === 0) continue
      expect(failed(await tool(srv, 'edit_message', { chat_id: '1', message_id: '100', buttons }))).toMatch(/^edit_message failed: (button label|buttons must be)/)
    }
    expect(calls(dir).slice(before).filter(c => SENDS.includes(c.method) || EDITS.includes(c.method))).toEqual([])
    expect(existsSync(join(dir, 'buttons.json'))).toBe(false)
    // A joined emoji, a single U+200E, 40 code points and plain words.
    const m = await ask(srv, 'Which?', [PASSING_LABELS])
    for (const label of PASSING_LABELS) {
      // Each press is on a fresh keyboard, set again after the one before.
      const p = press(dir, m, label)
      deliver(dir, [p.update])
      await answerTo(dir, p.id)
      await until(() => pressed(srv).length === PASSING_LABELS.indexOf(label) + 1)
      expect(pressed(srv).at(-1)!.meta.button).toBe(label)
      expect(pressed(srv).at(-1)!.content).toStartWith(`Pressed "${label}" on message ${m}`)
      await until(() => entryOf(dir, m) === undefined)
      ok(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [PASSING_LABELS] }))
    }
    await srv.close()
  }, 30000)

  test('non-empty buttons are refused in a bot’s chat and in a server that does not poll, while removing them is allowed in both', async () => {
    const BOT = { id: 7091, is_bot: true, first_name: 'Peer', username: 'peer_ninety_one_bot' }
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1', String(BOT.id)] })
    const srv = await channel(dir, { env: { TELEGRAM_TEST_USERS: JSON.stringify({ [BOT.id]: BOT }) } })
    expect(failed(await tool(srv, 'reply', { chat_id: String(BOT.id), text: 'Q', buttons: [['Yes']] }))).toBe("reply failed: buttons are refused in a bot's chat: a bot cannot press one")
    expect(failed(await tool(srv, 'edit_message', { chat_id: String(BOT.id), message_id: '77', buttons: [['Yes']] }))).toBe("edit_message failed: buttons are refused in a bot's chat: a bot cannot press one")
    expect(calls(dir).filter(c => SENDS.includes(c.method) || EDITS.includes(c.method))).toEqual([])
    ok(await tool(srv, 'edit_message', { chat_id: String(BOT.id), message_id: '77', buttons: [] }))
    expect(calls(dir).filter(c => EDITS.includes(c.method)).map(c => [c.method, c.payload])).toEqual([
      ['editMessageReplyMarkup', { chat_id: String(BOT.id), message_id: 77 }],
    ])
    const m = await ask(srv)
    await srv.close()

    const probe = await sender(dir)
    const from = calls(dir).length
    const refusal = 'buttons are refused here: this server does not poll the bot, so a press would reach whichever process polls'
    expect(failed(await tool(probe, 'reply', { chat_id: '1', text: 'Q', buttons: [['Yes']] }))).toBe(`reply failed: ${refusal}`)
    expect(failed(await tool(probe, 'edit_message', { chat_id: '1', message_id: String(m), text: 'Q', buttons: [['Yes']] }))).toBe(`edit_message failed: ${refusal}`)
    expect(calls(dir).slice(from)).toEqual([])
    // Removal goes through, and the record no longer holds the message.
    ok(await tool(probe, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [] }))
    expect(calls(dir).slice(from).filter(c => EDITS.includes(c.method)).map(c => [c.method, c.payload])).toEqual([
      ['editMessageReplyMarkup', { chat_id: '1', message_id: m }],
    ])
    expect(entryOf(dir, m)).toBeUndefined()
    await probe.close()
  }, 20000)

  test('non-empty buttons are refused from a poll that ended in 409 until a poll completes, a later poll that fails another way included, and removing them works throughout', async () => {
    const dir = state()
    const srv = start(dir, fixture.argv, envOf({ rules: [
      { method: 'getUpdates', times: 1, error: { error_code: 409, description: 'Conflict: terminated by other getUpdates request' } },
      { method: 'getUpdates', times: 1, error: { error_code: 502, description: 'Bad Gateway' } },
    ] }))
    await srv.ready()
    const polls = () => calls(dir).filter(c => c.method === 'getUpdates')
    const refusal = 'buttons are refused here: a poll of this server ended in a conflict (409) with no poll completed since, so a press would reach whichever process polls'
    const refused = async () => {
      expect(failed(await tool(srv, 'reply', { chat_id: '1', text: 'Q', buttons: [['Yes']] }))).toBe(`reply failed: ${refusal}`)
      expect(failed(await tool(srv, 'edit_message', { chat_id: '1', message_id: '77', buttons: [['Yes']] }))).toBe(`edit_message failed: ${refusal}`)
      expect(failed(await tool(srv, 'edit_message', { chat_id: '1', message_id: '77', text: 'Q', buttons: [['Yes']] }))).toBe(`edit_message failed: ${refusal}`)
      ok(await tool(srv, 'edit_message', { chat_id: '1', message_id: '77', buttons: [] }))
    }
    await until(() => polls()[0]?.refused !== undefined)
    await Bun.sleep(100)
    await refused()
    // The next poll fails with a 502, and grammY polls again 3 seconds later.
    await until(() => polls()[1]?.refused !== undefined, 5000)
    await Bun.sleep(100)
    expect(existsSync(join(dir, 'poll-heartbeat.json'))).toBe(false)
    await refused()
    // A completed poll writes the heartbeat.
    await until(() => existsSync(join(dir, 'poll-heartbeat.json')), 6000)
    await Bun.sleep(100)
    const m = await ask(srv)
    ok(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [] }))
    expect(calls(dir).filter(c => SENDS.includes(c.method) || c.method === 'editMessageText').map(c => [c.method, c.payload.text])).toEqual([['sendMessage', 'Merge now?']])
    expect(calls(dir).filter(c => c.method === 'editMessageReplyMarkup').map(c => [c.payload.message_id, c.payload.reply_markup])).toEqual([[77, undefined], [77, undefined], [m, undefined]])
    await srv.close()
  }, 30000)

  test('a rich part carrying the keyboard that Telegram rejects for its content goes plain, with the keyboard on the last message of that fallback', async () => {
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1'], textChunkLimit: 12 })
    const srv = await channel(dir, { env: { TELEGRAM_RICH_MESSAGES: 'true' }, rules: [{ method: 'sendRichMessage', has: 'REJECT-ME', error: REJECTED }] })
    const result = ok(await tool(srv, 'reply', { chat_id: '1', text: '**REJECT-ME** then more words', buttons: [['Yes', 'No']] }))
    const sent = calls(dir).filter(c => SENDS.includes(c.method))
    expect(sent.map(c => [c.method, c.payload.text ?? null, !!c.refused])).toEqual([
      ['sendRichMessage', null, true],
      ['sendMessage', '**REJECT-ME*', false], ['sendMessage', '* then more ', false], ['sendMessage', 'words', false],
    ])
    expect(markupOf(sent[0]!)).toBeDefined()
    expect(sent.slice(1, 3).map(markupOf)).toEqual([undefined, undefined])
    expect(markupOf(sent[3]!).inline_keyboard.map((row: any[]) => row.map(b => b.text))).toEqual([['Yes', 'No']])
    expect(markupOf(sent[3]!)).toEqual(markupOf(sent[0]!))
    expect(result).toBe(`sent 3 parts (ids: 100, 101, 102); buttons on message 102`)
    expect(entryOf(dir, 102)).toBeDefined()
    await srv.close()
  }, 15000)

  test('a keyboard Telegram refuses fails the reply at once with its description and no plain copy, while a rich part without the keyboard refused naming a button goes plain', async () => {
    const dir = state()
    mkdirSync(join(dir, 'inbox'))
    writeFileSync(join(dir, 'inbox', 'chart.png'), 'png')
    const BUTTON_IN_BODY = { error_code: 400, description: 'Bad Request: RICH_MESSAGE_BUTTON_INVALID' }
    const srv = await channel(dir, {
      env: { TELEGRAM_RICH_MESSAGES: 'true' },
      rules: [
        { method: 'sendRichMessage', has: 'KEYBOARD-BAD', markup: true, error: { error_code: 400, description: 'Bad Request: REPLY_MARKUP_INVALID' } },
        { method: 'sendMessage', has: 'KEYBOARD-BAD', markup: true, error: { error_code: 400, description: 'Bad Request: BUTTON_DATA_INVALID' } },
        { method: 'sendRichMessage', has: 'BODY-BUTTON', error: BUTTON_IN_BODY },
      ],
    })
    const sendsSince = (from: number) => calls(dir).slice(from).filter(c => SENDS.includes(c.method)).map(c => [c.method, !!c.refused])
    let from = calls(dir).length
    expect(failed(await tool(srv, 'reply', { chat_id: '1', text: '**KEYBOARD-BAD**', buttons: [['Yes']] }))).toBe(
      "reply failed: reply failed after 0 of 1 part(s) sent: Call to 'sendRichMessage' failed! (400: Bad Request: REPLY_MARKUP_INVALID)")
    expect(sendsSince(from)).toEqual([['sendRichMessage', true]])
    from = calls(dir).length
    expect(failed(await tool(srv, 'reply', { chat_id: '1', text: 'KEYBOARD-BAD', format: 'text', buttons: [['Yes']] }))).toBe(
      "reply failed: reply failed after 0 of 1 chunk(s) sent: Call to 'sendMessage' failed! (400: Bad Request: BUTTON_DATA_INVALID)")
    expect(sendsSince(from)).toEqual([['sendMessage', true]])
    // A button refused in a rich body, on the call that carries the keyboard.
    from = calls(dir).length
    expect(failed(await tool(srv, 'reply', { chat_id: '1', text: '**BODY-BUTTON**', buttons: [['Yes']] }))).toContain('RICH_MESSAGE_BUTTON_INVALID')
    expect(sendsSince(from)).toEqual([['sendRichMessage', true]])
    // A reply without buttons, and an earlier part of a reply with them, go plain.
    from = calls(dir).length
    expect(ok(await tool(srv, 'reply', { chat_id: '1', text: '**BODY-BUTTON**' }))).toBe('sent (id: 100)')
    expect(sendsSince(from)).toEqual([['sendRichMessage', true], ['sendMessage', false]])
    from = calls(dir).length
    expect(ok(await tool(srv, 'reply', { chat_id: '1', text: '**BODY-BUTTON**', files: [join(dir, 'inbox', 'chart.png')], buttons: [['Yes']] }))).toBe(
      'sent 2 parts (ids: 101, 102); buttons on message 102')
    expect(sendsSince(from)).toEqual([['sendRichMessage', true], ['sendMessage', false], ['sendPhoto', false]])
    // The failed replies left no reservation behind.
    expect(record(dir).entries).toEqual([expect.objectContaining({ chat: '1', message: 102 })])
    await srv.close()
  }, 15000)

  test('a reply that fails partway names the ids already sent, a file’s failure included', async () => {
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1'], textChunkLimit: 3 })
    mkdirSync(join(dir, 'inbox'))
    writeFileSync(join(dir, 'inbox', 'chart.png'), 'png')
    writeFileSync(join(dir, 'inbox', 'notes.txt'), 'notes')
    const WRONG = { error_code: 400, description: 'Bad Request: wrong file identifier' }
    const srv = await channel(dir, { rules: [
      { method: 'sendMessage', has: 'ccc', error: { error_code: 400, description: 'Bad Request: message is too long' } },
      { method: 'sendDocument', error: WRONG },
    ] })
    expect(failed(await tool(srv, 'reply', { chat_id: '1', text: 'aaabbbccc', buttons: [['Yes']] }))).toBe(
      "reply failed: reply failed after 2 of 3 chunk(s) sent (ids: 100, 101): Call to 'sendMessage' failed! (400: Bad Request: message is too long)")
    expect(failed(await tool(srv, 'reply', { chat_id: '1', text: 'aaa', files: [join(dir, 'inbox', 'chart.png'), join(dir, 'inbox', 'notes.txt')], buttons: [['Yes']] }))).toBe(
      "reply failed: reply failed after 2 of 3 message(s) sent (ids: 102, 103): Call to 'sendDocument' failed! (400: Bad Request: wrong file identifier)")
    // A reply that sent no keyboard leaves no reservation.
    expect(record(dir).entries).toEqual([])
    await srv.close()
  }, 15000)

  // Criterion 1: edit_message.

  test('edit_message with text sets, replaces and removes buttons on a text message in one call each', async () => {
    const dir = state()
    const srv = await channel(dir)
    const m = Number(/^sent \(id: (\d+)\)$/.exec(ok(await tool(srv, 'reply', { chat_id: '1', text: 'working' })))![1])
    const editCalls = () => calls(dir).filter(c => EDITS.includes(c.method))
    const labels = () => shown(dir, m)?.inline_keyboard.map((r: any[]) => r.map(b => b.text))
    ok(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), text: 'Merge?', buttons: [['Yes', 'No']] }))
    expect(labels()).toEqual([['Yes', 'No']])
    const k1 = entryOf(dir, m).keyboard
    ok(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), text: 'Merge now?', buttons: [['Yes'], ['Later']] }))
    expect(labels()).toEqual([['Yes'], ['Later']])
    expect(entryOf(dir, m).keyboard).toBe(k1 + 1)
    ok(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), text: 'Merged' }))
    expect(labels()).toBeUndefined()
    expect(entryOf(dir, m)).toBeUndefined()
    ok(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), text: 'Merge again?', buttons: [['Yes']] }))
    ok(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), text: 'Never mind', buttons: [] }))
    expect(editCalls().map(c => [c.method, c.payload.text, markupOf(c)?.inline_keyboard.length ?? 0])).toEqual([
      ['editMessageText', 'Merge?', 1], ['editMessageText', 'Merge now?', 2], ['editMessageText', 'Merged', 0],
      ['editMessageText', 'Merge again?', 1], ['editMessageText', 'Never mind', 0],
    ])
    expect(entryOf(dir, m)).toBeUndefined()
    await srv.close()
  }, 15000)

  test('a rich edit Telegram rejects for its content goes plain with the keyboard in the same call, and an edit whose keyboard Telegram refuses fails with no plain edit', async () => {
    const dir = state()
    const srv = await channel(dir, {
      env: { TELEGRAM_RICH_MESSAGES: 'true' },
      rules: [
        { method: 'editMessageText', has: ['REJECT-ME', 'rich_message'], error: REJECTED },
        { method: 'editMessageText', has: 'KEYBOARD-BAD', markup: true, error: { error_code: 400, description: 'Bad Request: REPLY_MARKUP_INVALID' } },
      ],
    })
    const m = await ask(srv, '**Merge?**')
    const k1 = entryOf(dir, m).keyboard
    let from = calls(dir).length
    ok(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), text: '**REJECT-ME**', buttons: [['Ship']] }))
    let edits = calls(dir).slice(from).filter(c => EDITS.includes(c.method))
    expect(edits.map(c => [c.payload.rich_message ? 'rich' : 'plain', !!c.refused, markupOf(c)?.inline_keyboard[0][0].text])).toEqual([
      ['rich', true, 'Ship'], ['plain', false, 'Ship'],
    ])
    expect(edits[1]!.payload.text).toBe('**REJECT-ME**')
    const k2 = entryOf(dir, m).keyboard
    expect(k2).toBe(k1 + 1)
    from = calls(dir).length
    expect(failed(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), text: '**KEYBOARD-BAD**', buttons: [['Wait']] }))).toBe(
      "edit_message failed: Call to 'editMessageText' failed! (400: Bad Request: REPLY_MARKUP_INVALID)")
    edits = calls(dir).slice(from).filter(c => EDITS.includes(c.method))
    expect(edits.map(c => [c.payload.rich_message ? 'rich' : 'plain', !!c.refused])).toEqual([['rich', true]])
    // The keyboard Telegram kept is the one the record names.
    expect(entryOf(dir, m).keyboard).toBe(k2)
    await srv.close()
  }, 15000)

  test('edit_message without text sets, replaces and removes buttons under a file and on a text message, whose text stays the same', async () => {
    const dir = state()
    mkdirSync(join(dir, 'inbox'))
    writeFileSync(join(dir, 'inbox', 'chart.png'), 'png')
    const srv = await channel(dir)
    expect(ok(await tool(srv, 'reply', { chat_id: '1', text: 'the chart', files: [join(dir, 'inbox', 'chart.png')] }))).toBe('sent 2 parts (ids: 100, 101)')
    for (const m of [101, 100]) {
      const from = calls(dir).length
      ok(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['Keep', 'Drop']] }))
      expect(shown(dir, m).inline_keyboard[0].map((b: any) => b.text)).toEqual(['Keep', 'Drop'])
      ok(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['Keep']] }))
      expect(shown(dir, m).inline_keyboard[0].map((b: any) => b.text)).toEqual(['Keep'])
      ok(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [] }))
      expect(shown(dir, m)).toBeUndefined()
      expect(calls(dir).slice(from).filter(c => EDITS.includes(c.method)).map(c => c.method)).toEqual(Array(3).fill('editMessageReplyMarkup'))
      expect(calls(dir).slice(from).some(c => 'text' in c.payload || 'caption' in c.payload)).toBe(false)
      expect(entryOf(dir, m)).toBeUndefined()
    }
    await srv.close()
  }, 15000)

  test('edit_message refuses a call with neither text nor buttons, and counts message is not modified as done', async () => {
    const dir = state()
    const srv = await channel(dir, { rules: [{ method: ['editMessageText', 'editMessageReplyMarkup'], has: 'SAME', error: NOT_MODIFIED }] })
    expect(failed(await tool(srv, 'edit_message', { chat_id: '1', message_id: '100' }))).toBe('edit_message failed: pass text, buttons, or both')
    expect(calls(dir).filter(c => EDITS.includes(c.method))).toEqual([])
    const m = await ask(srv, 'SAME question', [['SAME']])
    expect(ok(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), text: 'SAME question', buttons: [['SAME']] }))).toBe(`edited (id: ${m})`)
    expect(ok(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['SAME']] }))).toBe(`edited (id: ${m})`)
    expect(calls(dir).filter(c => EDITS.includes(c.method) && c.refused).length).toBe(2)
    await srv.close()
  }, 15000)

  // Criterion 2: presses.

  test('a press is answered, reaches Claude once after the batch waiting in the chat, with the label, message, presser, time and opening words, and the keyboard becomes one disabled button', async () => {
    const dir = state()
    const srv = await channel(dir)
    const m = await ask(srv, 'Deploy finished.\n\nMerge now?')
    const p = press(dir, m, 'Yes', { text: 'Deploy finished.\n\nMerge now?' })
    const before = Date.now()
    deliver(dir, [
      { message: { message_id: 10, date: now(), from: OWNER, chat: DM, text: 'one more thing' } },
      p.update,
    ])
    expect(await answerTo(dir, p.id)).toBeNull()
    await until(() => srv.inbound().length === 2)
    await until(() => entryOf(dir, m) === undefined)
    await Bun.sleep(300)
    const [first, event] = srv.inbound()
    expect(first.content).toBe('one more thing')
    expect(event).toEqual({
      content: `Pressed "Yes" on message ${m}: "Deploy finished. Merge now?"`,
      meta: { chat_id: '1', message_id: String(m), button: 'Yes', user: 'owner', user_id: '1', ts: expect.any(String) },
    })
    const ts = Date.parse(event.meta.ts)
    expect(ts).toBeGreaterThanOrEqual(before - 5)
    expect(ts).toBeLessThanOrEqual(Date.now())
    expect(srv.inbound()).toHaveLength(2)
    expect(swaps(dir, m).map(c => c.payload.reply_markup)).toEqual([chosen('Yes')])
    expect(shown(dir, m)).toEqual(chosen('Yes'))
    // The press started typing in its chat.
    expect(calls(dir).some(c => c.method === 'sendChatAction' && String(c.payload.chat_id) === '1')).toBe(true)
    await srv.close()
  }, 15000)

  test('in a group, a press goes after the batch another member’s text left waiting in the chat', async () => {
    const GROUP = { id: -100, type: 'supergroup', title: 'g' }
    const A = { id: 5, is_bot: false, first_name: 'A' }
    const B = { id: 6, is_bot: false, first_name: 'B' }
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1'], groups: { '-100': { requireMention: false, allowFrom: [] } } })
    const srv = await channel(dir)
    const m = Number(/buttons on message (\d+)$/.exec(ok(await tool(srv, 'reply', { chat_id: '-100', text: 'Lunch?', buttons: [['Yes', 'No']] })))![1])
    deliver(dir, [
      { message: { message_id: 10, date: now(), from: A, chat: GROUP, text: 'from A, still in its batch' } },
      press(dir, m, 'Yes', { chat: GROUP, from: B }).update,
    ])
    await until(() => srv.inbound().length === 2)
    expect(srv.inbound().map(n => [n.meta.user_id, n.meta.button ?? n.content])).toEqual([['5', 'from A, still in its batch'], ['6', 'Yes']])
    await srv.close()
  }, 15000)

  test('a press starts typing in its chat, a group’s included', async () => {
    const GROUP = { id: -100, type: 'supergroup', title: 'g' }
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1'], groups: { '-100': { requireMention: true, allowFrom: [] } } })
    const srv = await channel(dir)
    const m = Number(/buttons on message (\d+)$/.exec(ok(await tool(srv, 'reply', { chat_id: '-100', text: 'Lunch?', buttons: [['Yes', 'No']] })))![1])
    const typing = () => calls(dir).filter(c => c.method === 'sendChatAction' && String(c.payload.chat_id) === '-100')
    expect(typing()).toEqual([])
    deliver(dir, [press(dir, m, 'Yes', { chat: GROUP, from: { id: 5, is_bot: false, first_name: 'Member' } }).update])
    await until(() => pressed(srv).length === 1)
    await until(() => typing().length > 0)
    await srv.close()
  }, 15000)

  test('a press in a private chat makes it the last chat, so the subagent message goes there', async () => {
    const dir = state()
    const srv = await channel(dir)
    const m = await ask(srv)
    deliver(dir, [press(dir, m, 'Yes').update])
    await until(() => pressed(srv).length === 1)
    const base = join(dir, 'transcripts')
    mkdirSync(base)
    writeFileSync(join(base, 'agent-a1.meta.json'), JSON.stringify({ description: 'After the press' }))
    appendAgentEvent(agentEventFile(dir, srv.child.pid!), { t: Date.now(), event: 'start', agent_id: 'a1', agent_type: 'general-purpose', agent_base: join(base, 'agent-a1') })
    const panel = (c: Call) => c.method === 'sendMessage' && c.payload.text?.startsWith('🤖 Subagents')
    await until(() => calls(dir).some(panel), AGENT_TICK_MS + 4000)
    expect(calls(dir).find(panel)!.payload.chat_id).toBe('1')
    await srv.close()
  }, 15000)

  test('a press that waits for the lock carries the time the server got it', async () => {
    const dir = state()
    const srv = await channel(dir)
    const m = await ask(srv)
    const release = await lock(join(dir, 'buttons.lock'))
    deliver(dir, [press(dir, m, 'Yes').update])
    await until(() => !existsSync(join(dir, 'inbound.json')))
    // Telegram has handed the press over; the lock holds it for 2 seconds.
    const handed = Date.now()
    await Bun.sleep(2000)
    release()
    await until(() => pressed(srv).length === 1)
    expect(Date.parse(pressed(srv)[0].meta.ts)).toBeLessThan(handed + 1000)
    await srv.close()
  }, 15000)

  test('a press that came in one round behind another, whose swap Telegram holds, carries the time the server got it', async () => {
    const dir = state()
    const srv = await channel(dir, { rules: [{ method: 'editMessageReplyMarkup', times: 1, holdMs: 2000 }] })
    const first = await ask(srv)
    const second = await ask(srv, 'Deploy now?')
    deliver(dir, [press(dir, first, 'Yes').update, press(dir, second, 'No').update])
    await until(() => !existsSync(join(dir, 'inbound.json')))
    // Telegram has handed both presses over; the first one's swap takes 2 seconds.
    const handed = Date.now()
    await until(() => pressed(srv).length === 2, 8000)
    expect(pressed(srv).map(n => n.meta.button)).toEqual(['Yes', 'No'])
    expect(Date.parse(pressed(srv)[1].meta.ts)).toBeLessThan(handed + 1000)
    await srv.close()
  }, 15000)

  test('a press Telegram returns without the message’s text takes the opening words from what the server sent, else names the message by its number', async () => {
    const dir = state()
    const srv = await channel(dir)
    const m = await ask(srv, 'Ship the release?')
    const p = press(dir, m, 'No')
    deliver(dir, [p.update])
    await until(() => pressed(srv).length === 1)
    expect(pressed(srv)[0].content).toBe(`Pressed "No" on message ${m}: "Ship the release?"`)
    await srv.close()
    // A message the restarted server never sent goes by its number alone.
    const again = await channel(dir, { ids: 200 })
    ok(await tool(again, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['Yes', 'No']] }))
    const q = press(dir, m, 'Yes')
    deliver(dir, [q.update])
    await until(() => pressed(again).length === 1)
    expect(pressed(again)[0].content).toBe(`Pressed "Yes" on message ${m}`)
    await again.close()
  }, 20000)

  test('a second press queued before the swap, carrying the original keyboard, is answered and delivers nothing', async () => {
    const dir = state()
    const srv = await channel(dir)
    const m = await ask(srv)
    const yes = press(dir, m, 'Yes')
    const no = press(dir, m, 'No')
    deliver(dir, [yes.update, no.update])
    expect(await answerTo(dir, yes.id)).toBeNull()
    expect(await answerTo(dir, no.id)).toBe(CLOSED)
    await Bun.sleep(300)
    expect(pressed(srv).map(n => n.meta.button)).toEqual(['Yes'])
    expect(shown(dir, m)).toEqual(chosen('Yes'))
    await srv.close()
  }, 15000)

  test('a press queued before an edit, returned with the keyboard the edit replaced, delivers nothing and leaves the edit’s keyboard, whose next press delivers', async () => {
    const dir = state()
    const srv = await channel(dir)
    const m = await ask(srv)
    const old = shown(dir, m)
    ok(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['Ship', 'Wait']] }))
    const replaced = press(dir, m, 'Yes', { markup: old })
    deliver(dir, [replaced.update])
    expect(await answerTo(dir, replaced.id)).toBe(CLOSED)
    await Bun.sleep(300)
    expect(pressed(srv)).toEqual([])
    expect(swaps(dir, m)).toEqual([])
    expect(shown(dir, m).inline_keyboard[0].map((b: any) => b.text)).toEqual(['Ship', 'Wait'])
    const ship = press(dir, m, 'Ship')
    deliver(dir, [ship.update])
    await until(() => pressed(srv).length === 1)
    expect(pressed(srv)[0].meta.button).toBe('Ship')
    await srv.close()
  }, 15000)

  test('a press queued before a send-only server’s text edit removed the buttons delivers nothing and puts none back', async () => {
    const dir = state()
    const srv = await channel(dir)
    const m = await ask(srv)
    const old = shown(dir, m)
    const probe = await sender(dir)
    ok(await tool(probe, 'edit_message', { chat_id: '1', message_id: String(m), text: 'Moved on' }))
    expect(shown(dir, m)).toBeUndefined()
    const late = press(dir, m, 'Yes', { markup: old })
    deliver(dir, [late.update])
    expect(await answerTo(dir, late.id)).toBe(CLOSED)
    await Bun.sleep(300)
    expect(pressed(srv)).toEqual([])
    expect(shown(dir, m)).toBeUndefined()
    await probe.close()
    await srv.close()
  }, 15000)

  test('a press whose data is not on the message’s keyboard, or that Telegram returns without the keyboard, is answered with a notice and delivers nothing', async () => {
    const dir = state()
    const srv = await channel(dir)
    const m = await ask(srv)
    const data = dataOf(shown(dir, m), 'Yes')
    const elsewhere = press(dir, m, 'Yes', { data, markup: { inline_keyboard: [[{ text: 'Yes', callback_data: 'btn:1:0' }]] } })
    const bare = press(dir, m, 'Yes', { data, markup: null })
    const inaccessible = { id: 'cb-gone', update: { callback_query: { id: 'cb-gone', chat_instance: 'c', data, from: OWNER, message: { message_id: m, date: 0, chat: DM } } } }
    const real = press(dir, m, 'No')
    deliver(dir, [elsewhere.update, bare.update, inaccessible.update, real.update])
    await until(() => pressed(srv).length === 1)
    expect(answers(dir)).toMatchObject({ [elsewhere.id]: NOT_ON_MESSAGE, [bare.id]: NOT_ON_MESSAGE, 'cb-gone': NOT_ON_MESSAGE, [real.id]: null })
    expect(pressed(srv).map(n => n.meta.button)).toEqual(['No'])
    await srv.close()
  }, 15000)

  test('a press from a sender the chat does not admit, or from a bot, delivers nothing, and a member the group admits is delivered with requireMention on', async () => {
    const GROUP = { id: -100, type: 'supergroup', title: 'g' }
    const MEMBER = { id: 5, is_bot: false, first_name: 'Member', username: 'member' }
    const OUTSIDER = { id: 6, is_bot: false, first_name: 'Outsider' }
    const PEER = { id: 7, is_bot: true, first_name: 'Peer', username: 'peer_bot' }
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1'], groups: { '-100': { requireMention: true, allowFrom: ['5', '7'] } } })
    const srv = await channel(dir)
    const m = Number(/buttons on message (\d+)$/.exec(ok(await tool(srv, 'reply', { chat_id: '-100', text: 'Lunch?', buttons: [['Yes', 'No']] })))![1])
    const outsider = press(dir, m, 'Yes', { chat: GROUP, from: OUTSIDER })
    const bot = press(dir, m, 'Yes', { chat: GROUP, from: PEER })
    const member = press(dir, m, 'No', { chat: GROUP, from: MEMBER })
    deliver(dir, [outsider.update, bot.update, member.update])
    await until(() => pressed(srv).length === 1)
    expect(answers(dir)).toMatchObject({ [outsider.id]: null, [bot.id]: null, [member.id]: null })
    expect(pressed(srv).map(n => [n.meta.chat_id, n.meta.user_id, n.meta.button])).toEqual([['-100', '5', 'No']])
    // In a group, the first press answers for everyone.
    await until(() => entryOf(dir, m, '-100') === undefined)
    expect(shown(dir, m, '-100')).toEqual(chosen('No'))
    await srv.close()
  }, 15000)

  test('under dmPolicy disabled, the owner’s press delivers nothing', async () => {
    const dir = state({ dmPolicy: 'disabled', allowFrom: ['1'] })
    const srv = await channel(dir)
    const m = await ask(srv)
    const p = press(dir, m, 'Yes')
    deliver(dir, [p.update])
    expect(await answerTo(dir, p.id)).toBeNull()
    await Bun.sleep(300)
    expect(srv.inbound()).toEqual([])
    expect(entryOf(dir, m).taken).toBeUndefined()
    await srv.close()
  }, 15000)

  test('after a take whose swap failed with a 429, a press on another button delivers nothing and retries the swap showing the first label', async () => {
    const dir = state()
    const srv = await channel(dir, { rules: [{ method: 'editMessageReplyMarkup', has: 'disabled', times: 1, error: TOO_MANY }] })
    const m = await ask(srv)
    const yes = press(dir, m, 'Yes')
    deliver(dir, [yes.update])
    await until(() => swaps(dir, m).length === 1)
    await until(() => srv.stderr().includes('still pending'))
    expect(entryOf(dir, m).taken).toBe('Yes')
    // The buttons stay live; another press retries the swap.
    expect(shown(dir, m).inline_keyboard[0].map((b: any) => b.text)).toEqual(['Yes', 'No'])
    const no = press(dir, m, 'No')
    deliver(dir, [no.update])
    expect(await answerTo(dir, no.id)).toBe(CLOSED)
    await until(() => entryOf(dir, m) === undefined)
    expect(swaps(dir, m).map(c => [c.payload.reply_markup, !!c.refused])).toEqual([[chosen('Yes'), true], [chosen('Yes'), false]])
    expect(pressed(srv).map(n => n.meta.button)).toEqual(['Yes'])
    await srv.close()
  }, 15000)

  test('after a restart, a press carrying the id the message had before its buttons were set again delivers nothing, and one on the new keyboard delivers', async () => {
    const dir = state()
    const first = await channel(dir)
    const m = await ask(first)
    const old = shown(dir, m)
    ok(await tool(first, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['Yes', 'No']] }))
    await first.close()
    const second = await channel(dir, { ids: 200 })
    const stale = press(dir, m, 'Yes', { markup: old })
    const fresh = press(dir, m, 'No')
    deliver(dir, [stale.update, fresh.update])
    await until(() => pressed(second).length === 1)
    expect(answers(dir)[stale.id]).toBe(CLOSED)
    expect(pressed(second).map(n => n.meta.button)).toEqual(['No'])
    await second.close()
  }, 20000)

  test('a press whose answer to Telegram fails still reaches Claude', async () => {
    const dir = state()
    const srv = await channel(dir, { rules: [{ method: 'answerCallbackQuery', error: { error_code: 400, description: 'Bad Request: query is too old and response timeout expired or query ID is invalid' } }] })
    const m = await ask(srv)
    deliver(dir, [press(dir, m, 'Yes').update])
    await until(() => pressed(srv).length === 1)
    await until(() => entryOf(dir, m) === undefined)
    expect(calls(dir).filter(c => c.method === 'answerCallbackQuery' && c.refused)).toHaveLength(1)
    await srv.close()
  }, 15000)

  test('a press being judged when the server’s MCP input closes gets the press-again notice and leaves the record as it was, and pressed again it delivers through a second server', async () => {
    const dir = state()
    const first = await channel(dir)
    const m = await ask(first)
    const before = readFileSync(join(dir, 'buttons.json'), 'utf8')
    const p = press(dir, m, 'Yes')
    // The press waits for the lock this test holds.
    const release = await lock(join(dir, 'buttons.lock'))
    deliver(dir, [p.update])
    await until(() => !existsSync(join(dir, 'inbound.json')))
    await Bun.sleep(200)
    first.child.stdin.end()
    await Bun.sleep(300)
    release()
    await until(() => first.child.exitCode !== null, 4000)
    expect(answers(dir)[p.id]).toBe(PRESS_AGAIN)
    expect(readFileSync(join(dir, 'buttons.json'), 'utf8')).toBe(before)
    expect(first.inbound()).toEqual([])
    const second = await channel(dir, { ids: 200 })
    const again = press(dir, m, 'Yes')
    deliver(dir, [again.update])
    await until(() => pressed(second).length === 1)
    expect(pressed(second)[0].meta.message_id).toBe(String(m))
    await second.close()
  }, 20000)

  test('a polling server started with a taken entry swaps that keyboard to one disabled button with the taken label, with no press', async () => {
    const dir = state()
    writeFileSync(join(dir, 'buttons.json'), JSON.stringify({ next: 50, entries: [{ chat: '1', message: 77, keyboard: 40, taken: 'Later' }, { chat: '1', message: 78, keyboard: 41 }] }))
    const srv = await channel(dir)
    await until(() => swaps(dir, 77).length === 1)
    expect(swaps(dir, 77)[0]!.payload).toEqual({ chat_id: '1', message_id: 77, reply_markup: chosen('Later') })
    await until(() => entryOf(dir, 77) === undefined)
    expect(record(dir).entries).toEqual([{ chat: '1', message: 78, keyboard: 41 }])
    expect(calls(dir).filter(c => EDITS.includes(c.method))).toHaveLength(1)
    await srv.close()
  }, 15000)

  test('a lock held by a killed server is released, and the next press delivers', async () => {
    const dir = state()
    const first = await channel(dir, { rules: [{ method: 'editMessageReplyMarkup', holdMs: 30_000 }] })
    const m = await ask(first)
    // The edit holds the lock while its answer waits.
    const edit = tool(first, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['Ship']] }, 12_000).catch(() => {})
    await until(() => calls(dir).some(c => c.method === 'editMessageReplyMarkup'))
    process.kill(serverPid(dir), 'SIGKILL')
    await until(() => first.child.exitCode !== null)
    void edit
    expect(first.child.signalCode ?? first.child.exitCode).not.toBe(0)
    const second = await channel(dir, { ids: 200 })
    const m2 = await ask(second, 'Still there?')
    deliver(dir, [press(dir, m2, 'Yes').update])
    await until(() => pressed(second).length === 1)
    expect(pressed(second)[0].meta).toMatchObject({ message_id: String(m2), button: 'Yes' })
    await second.close()
  }, 20000)

  test('a record that cannot be written fails the reply before anything is sent, and a keyboard send held while the folder turns read-only fails the reply and removes its keyboard', async () => {
    const dir = state()
    const srv = await channel(dir, { rules: [{ method: 'sendMessage', has: 'HOLD', holdMs: 1500 }] })
    await ask(srv)
    chmodSync(dir, 0o500)
    let from = calls(dir).length
    try {
      expect(failed(await tool(srv, 'reply', { chat_id: '1', text: 'Q', buttons: [['Yes']] }))).toStartWith(
        'reply failed: could not record the buttons, so nothing was sent: ')
      expect(calls(dir).slice(from).filter(c => SENDS.includes(c.method))).toEqual([])
    } finally {
      chmodSync(dir, 0o700)
    }
    from = calls(dir).length
    const reply = tool(srv, 'reply', { chat_id: '1', text: 'HOLD', buttons: [['Yes']] }, 10_000)
    await until(() => calls(dir).slice(from).some(c => c.method === 'sendMessage'))
    chmodSync(dir, 0o500)
    let text: string
    try {
      text = failed(await reply)
    } finally {
      chmodSync(dir, 0o700)
    }
    const sent = calls(dir).slice(from).find(c => c.method === 'sendMessage')!
    expect(text).toStartWith(`reply failed: sent (ids: ${sent.message_id}), but could not record the buttons, so they were removed from message ${sent.message_id}: `)
    expect(calls(dir).slice(from).filter(c => EDITS.includes(c.method)).map(c => [c.method, c.payload])).toEqual([
      ['editMessageReplyMarkup', { chat_id: '1', message_id: sent.message_id }],
    ])
    expect(shown(dir, sent.message_id!)).toBeUndefined()
    await srv.close()
  }, 15000)

  test('an unreadable record is moved aside, and buttons work with a fresh one', async () => {
    const dir = state()
    writeFileSync(join(dir, 'buttons.json'), '{ not json')
    const srv = await channel(dir)
    const m = await ask(srv)
    expect(readdirSync(dir).filter(f => f.startsWith('buttons.json.corrupt-'))).toHaveLength(1)
    expect(entryOf(dir, m)).toBeDefined()
    expect(srv.stderr()).toContain('buttons.json is unreadable, moved aside')
    await srv.close()
  }, 15000)

  // Concurrency.

  test('with the keyboard’s send held, a press on that message delivers once, the reply then names it, and a second press delivers nothing', async () => {
    const dir = state()
    const srv = await channel(dir, { rules: [{ method: 'sendMessage', markup: true, holdMs: 1500 }] })
    const reply = tool(srv, 'reply', { chat_id: '1', text: 'Merge now?', buttons: [['Yes', 'No']] }, 10_000)
    await until(() => calls(dir).some(c => c.method === 'sendMessage'))
    const m = calls(dir).find(c => c.method === 'sendMessage')!.message_id!
    const first = press(dir, m, 'Yes')
    deliver(dir, [first.update])
    await until(() => pressed(srv).length === 1)
    const second = press(dir, m, 'No', { markup: calls(dir).find(c => c.method === 'sendMessage')!.payload.reply_markup })
    deliver(dir, [second.update])
    expect(await answerTo(dir, second.id)).toBe(CLOSED)
    expect(ok(await reply)).toBe(`sent (id: ${m}); buttons on message ${m}`)
    await Bun.sleep(300)
    expect(pressed(srv).map(n => n.meta.button)).toEqual(['Yes'])
    expect(entryOf(dir, m)).toBeUndefined()
    expect(record(dir).entries).toEqual([])
    await srv.close()
  }, 15000)

  test('with a swap held, an edit_message with new buttons from the same server waits for it, and the message ends with the edit’s keyboard', async () => {
    const dir = state()
    const srv = await channel(dir, { rules: [{ method: 'editMessageReplyMarkup', has: 'disabled', holdMs: 1500 }] })
    const m = await ask(srv)
    deliver(dir, [press(dir, m, 'Yes').update])
    await until(() => swaps(dir, m).length === 1)
    const swapAt = swaps(dir, m)[0]!.at
    ok(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['Again']] }, 10_000))
    const edit = calls(dir).findLast(c => c.method === 'editMessageReplyMarkup')!
    expect(edit.at).toBeGreaterThanOrEqual(swapAt + 1400)
    expect(shown(dir, m).inline_keyboard[0].map((b: any) => b.text)).toEqual(['Again'])
    expect(entryOf(dir, m).keyboard).toBe(Number(/^btn:(\d+):0$/.exec(dataOf(shown(dir, m), 'Again'))![1]))
    await srv.close()
  }, 15000)

  test('with a swap held, a removal from a second server waits for it, and the message ends without buttons', async () => {
    const dir = state()
    const srv = await channel(dir, { rules: [{ method: 'editMessageReplyMarkup', has: 'disabled', holdMs: 1500 }] })
    const m = await ask(srv)
    const probe = await sender(dir)
    deliver(dir, [press(dir, m, 'Yes').update])
    await until(() => swaps(dir, m).length === 1)
    const swapAt = swaps(dir, m)[0]!.at
    ok(await tool(probe, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [] }, 10_000))
    const removal = calls(dir).findLast(c => c.method === 'editMessageReplyMarkup')!
    expect(removal.pid).not.toBe(swaps(dir, m)[0]!.pid)
    expect(removal.at).toBeGreaterThanOrEqual(swapAt + 1400)
    expect(shown(dir, m)).toBeUndefined()
    expect(entryOf(dir, m)).toBeUndefined()
    await probe.close()
    await srv.close()
  }, 15000)

  test('with a swap held then answered with a 429, a take on one message and a second server’s removal on another, interleaved either way, both land', async () => {
    const dir = state()
    const srv = await channel(dir, { rules: [{ method: 'editMessageReplyMarkup', has: 'disabled', holdMs: 1500, error: TOO_MANY }] })
    const [a, b, c, d] = [await ask(srv, 'A?'), await ask(srv, 'B?'), await ask(srv, 'C?'), await ask(srv, 'D?')]
    const probe = await sender(dir, { rules: [{ method: 'editMessageReplyMarkup', holdMs: 1500 }] })
    // The removal first: the take waits for it, then reads the record anew.
    const removeB = tool(probe, 'edit_message', { chat_id: '1', message_id: String(b), buttons: [] }, 10_000)
    await until(() => calls(dir).some(x => x.method === 'editMessageReplyMarkup' && x.payload.message_id === b))
    deliver(dir, [press(dir, a, 'Yes').update])
    ok(await removeB)
    await until(() => swaps(dir, a).length === 1 && srv.stderr().includes(`swap on message ${a} in chat 1 still pending`), 6000)
    // The take first: the removal waits for its swap.
    deliver(dir, [press(dir, c, 'No').update])
    await until(() => swaps(dir, c).length === 1)
    ok(await tool(probe, 'edit_message', { chat_id: '1', message_id: String(d), buttons: [] }, 10_000))
    await until(() => srv.stderr().includes(`swap on message ${c} in chat 1 still pending`), 6000)
    expect(entryOf(dir, a)).toMatchObject({ taken: 'Yes' })
    expect(entryOf(dir, c)).toMatchObject({ taken: 'No' })
    expect(entryOf(dir, b)).toBeUndefined()
    expect(entryOf(dir, d)).toBeUndefined()
    expect(shown(dir, b)).toBeUndefined()
    expect(shown(dir, d)).toBeUndefined()
    expect(pressed(srv).map(n => n.meta.button)).toEqual(['Yes', 'No'])
    await probe.close()
    await srv.close()
  }, 20000)

  test(`opening a keyboard past ${RECORD_MAX} entries drops the oldest with no Telegram call, and a press on its buttons gets the closed notice`, async () => {
    const dir = state()
    // The oldest is a reservation never joined, then a message's keyboard.
    const entries: object[] = [{ chat: '1', keyboard: 1 }, { chat: '1', message: 2, keyboard: 2 }]
    for (let i = 3; i <= RECORD_MAX; i++) entries.push({ chat: '1', message: i, keyboard: i })
    writeFileSync(join(dir, 'buttons.json'), JSON.stringify({ next: 5000, entries }))
    const srv = await channel(dir, { ids: 3000 })
    const from = calls(dir).length
    await ask(srv, 'One')
    await ask(srv, 'Two')
    expect(calls(dir).slice(from).filter(c => SENDS.includes(c.method) || EDITS.includes(c.method)).map(c => c.method)).toEqual(['sendMessage', 'sendMessage'])
    const rec = record(dir)
    expect(rec.entries).toHaveLength(RECORD_MAX)
    expect(rec.entries[0]).toEqual({ chat: '1', message: 3, keyboard: 3 })
    const dropped = press(dir, 2, 'Old', { markup: { inline_keyboard: [[{ text: 'Old', callback_data: 'btn:2:0' }]] } })
    const held = press(dir, 3, 'Kept', { markup: { inline_keyboard: [[{ text: 'Kept', callback_data: 'btn:3:0' }]] } })
    deliver(dir, [dropped.update, held.update])
    await until(() => pressed(srv).length === 1)
    expect(answers(dir)[dropped.id]).toBe(CLOSED)
    expect(pressed(srv)[0].meta.message_id).toBe('3')
    await srv.close()
  }, 15000)

  // The polling server sends a message with no buttons; text edits come from
  // a server that does not poll, on the same state folder.
  async function plainPair(senderRules: object[], channelRules: object[] = []) {
    const dir = state()
    const p = await channel(dir, { rules: channelRules })
    // The record exists, holding another message.
    await ask(p)
    const m = Number(/^sent \(id: (\d+)\)$/.exec(ok(await tool(p, 'reply', { chat_id: '1', text: 'working' })))![1])
    const s = await sender(dir, { rules: senderRules })
    return { dir, p, s, m }
  }
  const editsOf = (dir: string, m: number) => calls(dir).filter(c => EDITS.includes(c.method) && c.payload.message_id === m)
  // Each edit of m in the fake's log: whose (s, the text editor, or p), which
  // call, the keyboard it carries, and whether Telegram refused it.
  function editLog(dir: string, m: number) {
    const edits = editsOf(dir, m)
    const s = edits.find(c => c.method === 'editMessageText')?.pid
    return edits.map(c => [c.pid === s ? 's' : 'p', c.method, markupOf(c) ? JSON.stringify(markupOf(c)) : 'none', c.refused ? 'refused' : 'ok'])
  }
  const PLAIN = { method: 'editMessageText', has: 'PLAIN' }
  const SET = { method: 'editMessageReplyMarkup', markup: true, has: '"No"' }

  test('with a text edit of a message the record does not hold held, buttons a second server sets land, and the message ends with them, set again after the text edit', async () => {
    const { dir, p, s, m } = await plainPair([{ ...PLAIN, holdMs: 2000 }])
    const text = tool(s, 'edit_message', { chat_id: '1', message_id: String(m), text: 'PLAIN' })
    await until(() => editsOf(dir, m).length === 1)
    ok(await tool(p, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['Yes', 'No']] }))
    const set = JSON.stringify(shown(dir, m))
    expect(ok(await text)).toBe(`edited (id: ${m})`)
    expect(editLog(dir, m)).toEqual([
      ['s', 'editMessageText', 'none', 'ok'],
      ['p', 'editMessageReplyMarkup', set, 'ok'],
      ['s', 'editMessageReplyMarkup', set, 'ok'],
    ])
    // The record holds that keyboard's id and labels.
    expect(entryOf(dir, m)).toEqual({ chat: '1', message: m, keyboard: Number(dataOf(JSON.parse(set), 'Yes').split(':')[1]), rows: [['Yes', 'No']] })
    await s.close()
    await p.close()
  }, 20000)

  test('a text edit reaching Telegram after a second server’s keyboard edit, whose answer is held, leaves the message with that keyboard, set again after the text edit', async () => {
    const { dir, p, s, m } = await plainPair([{ ...PLAIN, preMs: 1500 }], [{ ...SET, holdMs: 3000 }])
    const text = tool(s, 'edit_message', { chat_id: '1', message_id: String(m), text: 'PLAIN' })
    await Bun.sleep(200)
    const setting = tool(p, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['Yes', 'No']] })
    expect(ok(await text)).toBe(`edited (id: ${m})`)
    expect(ok(await setting)).toBe(`edited (id: ${m})`)
    // The keyboard the second server set.
    const set = editLog(dir, m)[0]![2]!
    expect(JSON.parse(set).inline_keyboard.flat().map((b: any) => b.text)).toEqual(['Yes', 'No'])
    // The text edit, sent first, reached the fake after the keyboard edit.
    expect(editLog(dir, m)).toEqual([
      ['p', 'editMessageReplyMarkup', set, 'ok'],
      ['s', 'editMessageText', 'none', 'ok'],
      ['s', 'editMessageReplyMarkup', set, 'ok'],
    ])
    expect(JSON.stringify(shown(dir, m))).toBe(set)
    await s.close()
    await p.close()
  }, 20000)

  test('in that order, with the keyboard set again answered message is not modified, the text edit still succeeds', async () => {
    const { dir, p, s, m } = await plainPair([{ ...PLAIN, holdMs: 2000 }, { method: 'editMessageReplyMarkup', error: NOT_MODIFIED }])
    const text = tool(s, 'edit_message', { chat_id: '1', message_id: String(m), text: 'PLAIN' })
    await until(() => editsOf(dir, m).length === 1)
    ok(await tool(p, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['Yes', 'No']] }))
    expect(ok(await text)).toBe(`edited (id: ${m})`)
    expect(editLog(dir, m).map(([who, method, , answer]) => [who, method, answer])).toEqual([
      ['s', 'editMessageText', 'ok'],
      ['p', 'editMessageReplyMarkup', 'ok'],
      ['s', 'editMessageReplyMarkup', 'refused'],
    ])
    await s.close()
    await p.close()
  }, 20000)

  test('a late text edit that Telegram applies but whose connection drops before an answer still leaves the message with that keyboard', async () => {
    const { dir, p, s, m } = await plainPair([{ ...PLAIN, preMs: 1500, drop: true }], [{ ...SET, holdMs: 3000 }])
    const text = tool(s, 'edit_message', { chat_id: '1', message_id: String(m), text: 'PLAIN' })
    await Bun.sleep(200)
    const setting = tool(p, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['Yes', 'No']] })
    expect(failed(await text)).toContain("Network request for 'editMessageText' failed")
    ok(await setting)
    // The keyboard the second server set.
    const set = editLog(dir, m)[0]![2]!
    expect(JSON.parse(set).inline_keyboard.flat().map((b: any) => b.text)).toEqual(['Yes', 'No'])
    expect(editLog(dir, m)).toEqual([
      ['p', 'editMessageReplyMarkup', set, 'ok'],
      ['s', 'editMessageText', 'none', 'ok'],
      ['s', 'editMessageReplyMarkup', set, 'ok'],
    ])
    expect(JSON.stringify(shown(dir, m))).toBe(set)
    await s.close()
    await p.close()
  }, 20000)

  test('when Telegram then refuses that held keyboard edit, the message ends without buttons, the record no longer holds it, and the text edit makes no further call', async () => {
    const refused = { error_code: 400, description: "Bad Request: message can't be edited" }
    const { dir, p, s, m } = await plainPair([{ ...PLAIN, preMs: 1500 }], [{ ...SET, holdMs: 3000, error: refused }])
    const text = tool(s, 'edit_message', { chat_id: '1', message_id: String(m), text: 'PLAIN' })
    await Bun.sleep(200)
    const setting = tool(p, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['Yes', 'No']] })
    expect(ok(await text)).toBe(`edited (id: ${m})`)
    expect(failed(await setting)).toContain("message can't be edited")
    await Bun.sleep(300)
    expect(editLog(dir, m).map(([who, method, , answer]) => [who, method, answer])).toEqual([
      ['p', 'editMessageReplyMarkup', 'refused'],
      ['s', 'editMessageText', 'ok'],
    ])
    expect(shown(dir, m)).toBeUndefined()
    expect(entryOf(dir, m)).toBeUndefined()
    await s.close()
    await p.close()
  }, 20000)

  test('when Telegram refuses the keyboard set again with a 429, the text edit fails with that description', async () => {
    const { dir, p, s, m } = await plainPair([{ ...PLAIN, preMs: 1500 }, { method: 'editMessageReplyMarkup', error: TOO_MANY }], [{ ...SET, holdMs: 3000 }])
    const text = tool(s, 'edit_message', { chat_id: '1', message_id: String(m), text: 'PLAIN' })
    await Bun.sleep(200)
    const setting = tool(p, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['Yes', 'No']] })
    expect(failed(await text)).toBe(`edit_message failed: the text was edited, but the buttons another call gave message ${m} meanwhile could not be set again: Call to 'editMessageReplyMarkup' failed! (429: Too Many Requests: retry after 5)`)
    ok(await setting)
    expect(editLog(dir, m).map(([who, method, , answer]) => [who, method, answer])).toEqual([
      ['p', 'editMessageReplyMarkup', 'ok'],
      ['s', 'editMessageText', 'ok'],
      ['s', 'editMessageReplyMarkup', 'refused'],
    ])
    await s.close()
    await p.close()
  }, 20000)

  test('when the answer to the keyboard set again is held past 10 seconds, the text edit fails saying the change may still land', async () => {
    const { dir, p, s, m } = await plainPair([{ ...PLAIN, preMs: 1500 }, { method: 'editMessageReplyMarkup', holdMs: 11_000 }], [{ ...SET, holdMs: 3000 }])
    const text = tool(s, 'edit_message', { chat_id: '1', message_id: String(m), text: 'PLAIN' }, 25_000)
    await Bun.sleep(200)
    const setting = tool(p, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['Yes', 'No']] })
    ok(await setting)
    expect(failed(await text)).toBe(`edit_message failed: the text was edited, but the buttons another call gave message ${m} meanwhile could not be set again: Telegram did not answer within 10 s; the change may still land`)
    expect(editLog(dir, m).map(([who, method]) => [who, method])).toEqual([
      ['p', 'editMessageReplyMarkup'],
      ['s', 'editMessageText'],
      ['s', 'editMessageReplyMarkup'],
    ])
    await s.close()
    await p.close()
  }, 35000)

  test('when a press takes the keyboard and its swap gets a 429 before the late text edit arrives, the message ends with one disabled button showing the label, and the record no longer holds it', async () => {
    const { dir, p, s, m } = await plainPair([{ ...PLAIN, preMs: 3000 }], [{ method: 'editMessageReplyMarkup', has: 'disabled', times: 1, error: TOO_MANY }])
    const text = tool(s, 'edit_message', { chat_id: '1', message_id: String(m), text: 'PLAIN' })
    await Bun.sleep(200)
    ok(await tool(p, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['Yes', 'No']] }))
    const set = JSON.stringify(shown(dir, m))
    deliver(dir, [press(dir, m, 'Yes').update])
    await until(() => pressed(p).length === 1)
    expect(ok(await text)).toBe(`edited (id: ${m})`)
    expect(editLog(dir, m)).toEqual([
      ['p', 'editMessageReplyMarkup', set, 'ok'],
      ['p', 'editMessageReplyMarkup', JSON.stringify(chosen('Yes')), 'refused'],
      ['s', 'editMessageText', 'none', 'ok'],
      ['s', 'editMessageReplyMarkup', JSON.stringify(chosen('Yes')), 'ok'],
    ])
    expect(shown(dir, m)).toEqual(chosen('Yes'))
    expect(entryOf(dir, m)).toBeUndefined()
    await s.close()
    await p.close()
  }, 20000)

  test('a text edit of a message no other call touches makes exactly one call, and succeeds with its answer held past 10 seconds', async () => {
    const { dir, p, s, m } = await plainPair([{ ...PLAIN, holdMs: 11_000 }])
    expect(ok(await tool(s, 'edit_message', { chat_id: '1', message_id: String(m), text: 'PLAIN' }, 15_000))).toBe(`edited (id: ${m})`)
    await Bun.sleep(300)
    expect(editLog(dir, m)).toEqual([['s', 'editMessageText', 'none', 'ok']])
    await s.close()
    await p.close()
  }, 30000)

  test('a removal of buttons from a message the record does not hold runs under the 10-second limit', async () => {
    const dir = state()
    const srv = await channel(dir, { rules: [{ method: 'editMessageReplyMarkup', holdMs: 11_000 }] })
    const m = Number(/^sent \(id: (\d+)\)$/.exec(ok(await tool(srv, 'reply', { chat_id: '1', text: 'working' })))![1])
    expect(failed(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [] }, 15_000))).toBe('edit_message failed: Telegram did not answer within 10 s; the change may still land')
    await srv.close()
  }, 25000)

  test('an edit whose answer is held past 10 seconds fails saying the change may still land, and a press on the keyboard it replaced delivers nothing', async () => {
    const dir = state()
    const srv = await channel(dir, { rules: [{ method: 'editMessageReplyMarkup', has: 'Ship', holdMs: 11_000 }] })
    const m = await ask(srv)
    const old = shown(dir, m)
    const k1 = entryOf(dir, m).keyboard
    const started = Date.now()
    expect(failed(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['Ship']] }, 15_000))).toBe(
      'edit_message failed: Telegram did not answer within 10 s; the change may still land')
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_900)
    expect(entryOf(dir, m).keyboard).toBe(k1 + 1)
    const stale = press(dir, m, 'Yes', { markup: old })
    deliver(dir, [stale.update])
    expect(await answerTo(dir, stale.id)).toBe(CLOSED)
    await Bun.sleep(200)
    expect(pressed(srv)).toEqual([])
    await srv.close()
  }, 25000)

  test('a plain text edit of a message the record does not hold, answered message is not modified, counts as done', async () => {
    const dir = state()
    const srv = await channel(dir, { rules: [{ method: 'editMessageText', error: NOT_MODIFIED }] })
    const m = Number(/^sent \(id: (\d+)\)$/.exec(ok(await tool(srv, 'reply', { chat_id: '1', text: 'working' })))![1])
    expect(ok(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), text: 'working' }))).toBe(`edited (id: ${m})`)
    expect(calls(dir).filter(c => c.method === 'editMessageText').map(c => [c.payload.message_id, c.refused !== undefined])).toEqual([[m, true]])
    await srv.close()
  }, 15000)

  test('a swap refused with a 400 ends its entry, and the next press gets the closed notice', async () => {
    const dir = state()
    const srv = await channel(dir, { rules: [{ method: 'editMessageReplyMarkup', has: 'disabled', error: { error_code: 400, description: "Bad Request: message can't be edited" } }] })
    const m = await ask(srv)
    deliver(dir, [press(dir, m, 'Yes').update])
    await until(() => pressed(srv).length === 1)
    await until(() => entryOf(dir, m) === undefined)
    const next = press(dir, m, 'No')
    deliver(dir, [next.update])
    expect(await answerTo(dir, next.id)).toBe(CLOSED)
    await srv.close()
  }, 15000)

  test('an edit Telegram refuses leaves the old keyboard delivering, and one answered message to edit not found ends the entry', async () => {
    const dir = state()
    const srv = await channel(dir, { rules: [
      { method: 'editMessageReplyMarkup', has: 'Refused', error: { error_code: 400, description: 'Bad Request: MESSAGE_ID_INVALID' } },
      { method: 'editMessageText', has: 'Gone', error: { error_code: 400, description: 'Bad Request: message to edit not found' } },
    ] })
    const m = await ask(srv)
    const k1 = entryOf(dir, m).keyboard
    expect(failed(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['Refused']] }))).toContain('MESSAGE_ID_INVALID')
    expect(entryOf(dir, m)).toEqual({ chat: '1', message: m, keyboard: k1, rows: [['Yes', 'No']] })
    deliver(dir, [press(dir, m, 'Yes').update])
    await until(() => pressed(srv).length === 1)
    const n = await ask(srv, 'Another?')
    const old = shown(dir, n)
    expect(failed(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(n), text: 'Gone', buttons: [['Gone']] }))).toContain('message to edit not found')
    expect(entryOf(dir, n)).toBeUndefined()
    const late = press(dir, n, 'Yes', { markup: old })
    deliver(dir, [late.update])
    expect(await answerTo(dir, late.id)).toBe(CLOSED)
    await srv.close()
  }, 15000)

  test('removed buttons end their entry, and a press on a keyboard the record no longer holds gets the closed notice', async () => {
    const dir = state()
    const srv = await channel(dir)
    const m = await ask(srv)
    const old = shown(dir, m)
    ok(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [] }))
    expect(entryOf(dir, m)).toBeUndefined()
    const p = press(dir, m, 'Yes', { markup: old })
    deliver(dir, [p.update])
    expect(await answerTo(dir, p.id)).toBe(CLOSED)
    await Bun.sleep(200)
    expect(pressed(srv)).toEqual([])
    await srv.close()
  }, 15000)

  test('a server started after another sent the keyboard delivers a press whose message carries that keyboard, read from the fake’s log', async () => {
    const dir = state()
    const first = await channel(dir)
    const m = await ask(first)
    await first.close()
    const second = await channel(dir, { ids: 200 })
    deliver(dir, [press(dir, m, 'No').update])
    await until(() => pressed(second).length === 1)
    expect(pressed(second)[0].meta).toMatchObject({ message_id: String(m), button: 'No' })
    await second.close()
  }, 20000)

  // Permission buttons.

  const ASK = { request_id: 'abcde', tool_name: 'Write', description: 'Write a file', input_preview: '{"file_path":"/w/a.txt"}' }
  const permissionAnswers = (srv: Server) => srv.notifications.filter(n => n.method === 'notifications/claude/channel/permission').map(n => n.params)

  test('Allow, Deny and See more from anyone but the owner, and the notice’s See more from a stranger, get "Not authorized." before the keyboard check', async () => {
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1', '5'] })
    const srv = await channel(dir, { env: { TELEGRAM_ALERT_CHAT: '1' } })
    srv.notify('notifications/claude/channel/permission_request', ASK)
    await until(() => calls(dir).some(c => c.method === 'sendMessage' && c.payload.text === '🔐 Permission: Write'))
    const PERSON = { id: 5, is_bot: false, first_name: 'Person' }
    const STRANGER = { id: 6, is_bot: false, first_name: 'Stranger' }
    // Taps with no keyboard on their message, as a rich body's buttons come.
    const bare = (id: string, from: { id: number }, data: string) =>
      ({ id, update: { callback_query: { id, chat_instance: 'c', data, from, message: { message_id: 7, date: now(), chat: { id: from.id, type: 'private' }, text: 'x' } } } })
    const taps = [
      bare('cb-allow', PERSON, 'perm:allow:abcde'), bare('cb-deny', PERSON, 'perm:deny:abcde'), bare('cb-more', PERSON, 'perm:more:abcde'),
      bare('cb-permit', STRANGER, 'permit:p1'),
    ]
    deliver(dir, taps.map(t => t.update))
    await until(() => taps.every(t => t.id in answers(dir)))
    expect(taps.map(t => answers(dir)[t.id])).toEqual(Array(4).fill('Not authorized.'))
    expect(permissionAnswers(srv)).toEqual([])
    await srv.close()
  }, 15000)

  test('the owner pressing a button labelled yes abcde settles no permission prompt', async () => {
    const dir = state()
    const srv = await channel(dir, { env: { TELEGRAM_ALERT_CHAT: '1' } })
    srv.notify('notifications/claude/channel/permission_request', ASK)
    await until(() => calls(dir).some(c => c.method === 'sendMessage' && c.payload.text === '🔐 Permission: Write'))
    const m = await ask(srv, 'Answer?', [['yes abcde']])
    deliver(dir, [press(dir, m, 'yes abcde').update])
    await until(() => pressed(srv).length === 1)
    expect(pressed(srv)[0].meta.button).toBe('yes abcde')
    await Bun.sleep(300)
    expect(permissionAnswers(srv)).toEqual([])
    await srv.close()
  }, 15000)

  test('Allow, Deny or See more data for a pending prompt, or the notice’s See more data, from a message whose own keyboard lacks it, settles or expands nothing', async () => {
    const dir = state()
    const srv = await channel(dir, { env: { TELEGRAM_ALERT_CHAT: '1' } })
    srv.notify('notifications/claude/channel/permission_request', ASK)
    const ev = { t: Date.now(), event: 'allowed' as const, tool_name: 'Bash', description: 'List files' }
    appendPermit(permitFile(dir, srv.child.pid!), ev)
    await until(() => calls(dir).some(c => c.method === 'sendMessage' && c.payload.text === permitText(ev)), 6000)
    const prompt = calls(dir).find(c => c.method === 'sendMessage' && c.payload.text === '🔐 Permission: Write')!
    const m = await ask(srv)
    // Taps as a rich message's body buttons arrive: the data, under a message
    // whose own keyboard is the answer buttons.
    const body = (data: string) => press(dir, m, 'Yes', { data, markup: shown(dir, m) })
    const taps = ['perm:allow:abcde', 'perm:deny:abcde', 'perm:more:abcde', 'permit:p1'].map(body)
    deliver(dir, taps.map(t => t.update))
    await until(() => taps.every(t => t.id in answers(dir)))
    expect(taps.map(t => answers(dir)[t.id])).toEqual(Array(4).fill(NOT_ON_MESSAGE))
    await Bun.sleep(300)
    expect(permissionAnswers(srv)).toEqual([])
    expect(calls(dir).filter(c => c.method === 'editMessageText')).toEqual([])
    expect(pressed(srv)).toEqual([])
    // On the prompt's own keyboard, Deny settles it as before.
    const deny = { id: 'cb-deny', update: { callback_query: { id: 'cb-deny', chat_instance: 'c', data: 'perm:deny:abcde', from: OWNER,
      message: { message_id: prompt.message_id, date: now(), chat: DM, text: '🔐 Permission: Write', reply_markup: prompt.payload.reply_markup } } } }
    deliver(dir, [deny.update])
    expect(await answerTo(dir, deny.id)).toBe('❌ Denied')
    expect(permissionAnswers(srv)).toEqual([{ request_id: 'abcde', behavior: 'deny' }])
    await srv.close()
  }, 15000)
})
