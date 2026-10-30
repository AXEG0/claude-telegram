// What a send or an edit that Telegram refused, or left unanswered, tells
// Claude (outcome.ts), and the Telegram calls made after an update is handled,
// which run beside polling, in the running server. Only Telegram's HTTP is
// fake.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import fixture from './fixtures/channel-argv.json'
import { calls, cleanup, deliver, driveClock, start, state, until, wait, type Call, type Server } from './fixtures/harness.ts'
import { CLOSED, lock } from './buttons.ts'

beforeEach(driveClock)
afterEach(cleanup)

const OWNER = { id: 1, is_bot: false, first_name: 'Owner', username: 'owner' }
const STRANGER = { id: 3, is_bot: false, first_name: 'Stranger' }
const PEER = { id: 7080, is_bot: true, first_name: 'Peer', username: 'peer_eighty_bot' }
const DM = { id: 1, type: 'private' }
const now = () => Math.floor(Date.now() / 1000)
const SENDS = ['sendMessage', 'sendPhoto', 'sendDocument', 'sendRichMessage', 'sendMediaGroup']
const EDITS = ['editMessageText', 'editMessageReplyMarkup']
const UNKNOWN = 'delivery unknown: Telegram may still deliver it, even minutes later; do not resend unless the recipient says it did not arrive'
const UNKNOWN_EDIT = 'edit outcome unknown; repeating the same edit is safe'
const GATEWAY = { error_code: 504, description: 'Gateway Timeout' }
const ANSWERED_504 = '(Telegram answered 504: Gateway Timeout)'

type Options = { rules?: object[]; env?: Record<string, string>; argv?: string[] }
async function server(dir: string, o: Options = {}): Promise<Server> {
  const polling = !o.argv
  const srv = start(dir, o.argv ?? fixture.argv, {
    TELEGRAM_TEST_CHATS: JSON.stringify({ ids: 100 }),
    TELEGRAM_TEST_RULES: JSON.stringify(o.rules ?? []),
    ...o.env,
  })
  await srv.ready()
  if (polling) await until(() => srv.stderr().includes('polling as '), 6000)
  return srv
}
const tool = async (srv: Server, name: string, args: object, timeout?: number) =>
  (await srv.request('tools/call', { name, arguments: args }, timeout)).result
const text = (r: any): string => r.content[0].text
const ok = (r: any): string => {
  if (r.isError) throw new Error(`tool failed: ${text(r)}`)
  return text(r)
}
const failed = (r: any): string => {
  expect(r.isError).toBe(true)
  return text(r)
}
const sends = (dir: string) => calls(dir).filter(c => SENDS.includes(c.method))
const record = (dir: string) => JSON.parse(readFileSync(join(dir, 'buttons.json'), 'utf8'))
const markupOf = (c: Call) => typeof c.payload.reply_markup === 'string' ? JSON.parse(c.payload.reply_markup) : c.payload.reply_markup
// The keyboard a message shows now, by the fake's log: the send that gave it
// its id, then every edit Telegram took.
function shown(dir: string, message: number): any {
  let markup: any
  for (const c of calls(dir)) {
    if (c.refused || String(c.payload.chat_id) !== '1') continue
    if (SENDS.includes(c.method) && c.message_id === message) markup = markupOf(c)
    if (EDITS.includes(c.method) && c.payload.message_id === message) markup = markupOf(c)
  }
  return markup
}
let seq = 0
function press(message: number, label: string, markup: any) {
  const data = markup.inline_keyboard.flat().find((b: any) => b.text === label).callback_data
  const id = `cb${++seq}`
  return { id, update: { callback_query: { id, chat_instance: 'c', data, from: OWNER, message: { message_id: message, date: now(), chat: DM, reply_markup: markup } } } }
}
const answerOf = (dir: string, id: string) => calls(dir).find(c => c.method === 'answerCallbackQuery' && c.payload.callback_query_id === id)
const pressed = (srv: Server) => srv.inbound().filter(n => n.meta.button !== undefined).map(n => n.meta.button)
const dm = (update_id: number, from: { id: number }, words: string, extra: object = {}) =>
  ({ update_id, message: { message_id: 500 + update_id, date: now(), from, chat: { id: from.id, type: 'private' }, text: words, ...extra } })

describe.skipIf(process.platform !== 'linux')('what a refused or unanswered send tells Claude', () => {
  test.each([
    ['a 429', { error: { error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } } },
      'reply failed: not sent; Telegram asks to wait 7 s (Telegram answered 429: Too Many Requests: retry after 7)'],
    ['another 4xx', { error: { error_code: 403, description: 'Forbidden: bot was blocked by the user' } },
      'reply failed: not sent (Telegram answered 403: Forbidden: bot was blocked by the user)'],
    ['a refused connection', { network: 'ECONNREFUSED' },
      'reply failed: not sent (ECONNREFUSED: Unable to connect. Is the computer able to access the url?)'],
  ])('%s on a send says not sent', async (_name, rule, expected) => {
    const dir = state()
    const srv = await server(dir, { rules: [{ method: 'sendMessage', ...rule }] })
    expect(failed(await tool(srv, 'reply', { chat_id: '1', text: 'hello' }))).toBe(expected)
    await srv.close()
  }, 15000)

  test.each([
    ['a text', 'sendMessage', {}, { text: 'hello', format: 'text' }, `reply: ${UNKNOWN} ${ANSWERED_504}`],
    ['a rich text', 'sendRichMessage', { TELEGRAM_RICH_MESSAGES: 'true' }, { text: '**hello**' }, `reply: ${UNKNOWN} ${ANSWERED_504}`],
    ['a file after its text', 'sendDocument', {}, { text: 'the notes', files: ['notes.txt'] },
      `reply: part 2 of 2: ${UNKNOWN} ${ANSWERED_504}; sent so far: 1 message(s) (ids: 100); never tried: none`],
    ['a photo', 'sendPhoto', {}, { text: 'the chart', files: ['chart.png'] },
      `reply: part 2 of 2: ${UNKNOWN} ${ANSWERED_504}; sent so far: 1 message(s) (ids: 100); never tried: none`],
  ])('%s whose send Telegram answers with a 5xx says delivery unknown, and nothing is sent again', async (_name, method, env, args, expected) => {
    const dir = state()
    mkdirSync(join(dir, 'inbox'))
    for (const f of ['notes.txt', 'chart.png']) writeFileSync(join(dir, 'inbox', f), f)
    const srv = await server(dir, { env, rules: [{ method, error: GATEWAY }] })
    const files = (args as { files?: string[] }).files?.map(f => join(dir, 'inbox', f))
    expect(failed(await tool(srv, 'reply', { chat_id: '1', ...args, ...(files ? { files } : {}) }))).toBe(expected)
    await wait(1000)
    expect(sends(dir).filter(c => c.method === method)).toHaveLength(1)
    // The rich part is not sent plain instead.
    expect(sends(dir).map(c => c.method)).toEqual(files ? ['sendMessage', method] : [method])
    await srv.close()
  }, 15000)

  test.each([
    ['the album', 'sendMediaGroup', (ids: number[]) => `reply: part 1 of 3 (an album of 2 documents): ${UNKNOWN} ${ANSWERED_504}; sent so far: none; never tried: parts 2 to 3`],
    ['a text piece after the album', 'sendMessage', (ids: number[]) => `reply: part 2 of 3: ${UNKNOWN} ${ANSWERED_504}; sent so far: 2 message(s) (ids: ${ids.join(', ')}); never tried: part 3`],
  ])('to a bot, %s answered with a 5xx says delivery unknown, and nothing is sent again', async (_name, method, expected) => {
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1', String(PEER.id)] })
    mkdirSync(join(dir, 'inbox'))
    for (const f of ['a.txt', 'b.txt']) writeFileSync(join(dir, 'inbox', f), f)
    const srv = await server(dir, {
      argv: ['claude', '-p', 'hello'],
      env: { TELEGRAM_TEST_USERS: JSON.stringify({ [PEER.id]: PEER }), TELEGRAM_TEST_CHATS: JSON.stringify({ ids: 100 }) },
      rules: [{ method, error: GATEWAY }],
    })
    const r = await tool(srv, 'reply', { chat_id: String(PEER.id), text: 'x'.repeat(5000), files: [join(dir, 'inbox', 'a.txt'), join(dir, 'inbox', 'b.txt')] })
    const album = calls(dir).find(c => c.method === 'sendMediaGroup' && !c.refused) as (Call & { message_ids?: number[] }) | undefined
    expect(failed(r)).toBe(expected(album?.message_ids ?? []))
    await wait(1000)
    expect(sends(dir).filter(c => c.method === method)).toHaveLength(1)
    await srv.close()
  }, 15000)

  test('a send whose connection drops before Telegram answers says delivery unknown', async () => {
    const dir = state()
    const srv = await server(dir, { rules: [{ method: 'sendMessage', drop: true }] })
    expect(failed(await tool(srv, 'reply', { chat_id: '1', text: 'hello' }))).toBe(`reply: ${UNKNOWN} (fetch failed: the connection was reset)`)
    expect(sends(dir)).toHaveLength(1)
    await srv.close()
  }, 15000)

  test('a reply of several parts names the parts sent with their ids, the part whose outcome is unknown and the parts never tried, and drops buttons that part did not carry', async () => {
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1'], textChunkLimit: 3 })
    const srv = await server(dir, { rules: [{ method: 'sendMessage', has: 'bbb', error: GATEWAY }] })
    expect(failed(await tool(srv, 'reply', { chat_id: '1', text: 'aaabbbccc', buttons: [['Yes']] }))).toBe(
      `reply: part 2 of 3: ${UNKNOWN} ${ANSWERED_504}; sent so far: 1 message(s) (ids: 100); never tried: part 3`)
    await wait(1000)
    expect(sends(dir).map(c => c.payload.text)).toEqual(['aaa', 'bbb'])
    expect(record(dir).entries).toEqual([])
    await srv.close()
  }, 15000)

  test('when the part whose outcome is unknown carries the buttons, they are kept, the result says so, and a press on that message once it lands counts', async () => {
    const dir = state()
    const srv = await server(dir, { rules: [{ method: 'sendMessage', markup: true, times: 1, error: GATEWAY, lands: true }] })
    expect(failed(await tool(srv, 'reply', { chat_id: '1', text: 'Merge now?', buttons: [['Yes', 'No']] }))).toBe(
      `reply: ${UNKNOWN} ${ANSWERED_504}; its buttons are kept, so a press on them counts if it arrives`)
    const landed = sends(dir)[0]!
    expect(landed.message_id).toBe(100)
    expect(record(dir).entries).toEqual([expect.objectContaining({ chat: '1', rows: [['Yes', 'No']] })])
    expect(record(dir).entries[0].message).toBeUndefined()
    const p = press(100, 'Yes', markupOf(landed))
    deliver(dir, [p.update])
    await until(() => pressed(srv).length === 1)
    await wait(500)
    expect(pressed(srv)).toEqual(['Yes'])
    expect(answerOf(dir, p.id)?.payload.text).toBeUndefined()
    await srv.close()
  }, 15000)
})

describe.skipIf(process.platform !== 'linux')('what a refused or unanswered edit tells Claude', () => {
  test('a text edit whose outcome is unknown says so and that repeating it is safe, the repeat goes through, and one Telegram refuses says not edited', async () => {
    const dir = state()
    const srv = await server(dir, { rules: [
      { method: 'editMessageText', has: 'done', times: 1, error: GATEWAY },
      { method: 'editMessageText', has: 'later', error: { error_code: 429, description: 'Too Many Requests: retry after 5', parameters: { retry_after: 5 } } },
    ] })
    const m = Number(/^sent \(id: (\d+)\)$/.exec(ok(await tool(srv, 'reply', { chat_id: '1', text: 'working' })))![1])
    expect(failed(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), text: 'done' }))).toBe(`edit_message: ${UNKNOWN_EDIT} ${ANSWERED_504}`)
    expect(ok(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), text: 'done' }))).toBe(`edited (id: ${m})`)
    expect(failed(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), text: 'later' }))).toBe(
      'edit_message failed: not edited; Telegram asks to wait 5 s (Telegram answered 429: Too Many Requests: retry after 5)')
    await srv.close()
  }, 15000)

  test('a buttons edit Telegram took but answered with a 5xx keeps its new keyboard current, so a press on it counts', async () => {
    const dir = state()
    const srv = await server(dir, { rules: [{ method: 'editMessageReplyMarkup', has: 'Ship', times: 1, error: GATEWAY, lands: true }] })
    const m = Number(/; buttons on message (\d+)$/.exec(ok(await tool(srv, 'reply', { chat_id: '1', text: 'Merge now?', buttons: [['Yes', 'No']] })))![1])
    expect(failed(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['Ship', 'Hold']] }))).toBe(`edit_message: ${UNKNOWN_EDIT} ${ANSWERED_504}`)
    expect(shown(dir, m).inline_keyboard[0].map((b: any) => b.text)).toEqual(['Ship', 'Hold'])
    const p = press(m, 'Ship', shown(dir, m))
    deliver(dir, [p.update])
    await until(() => pressed(srv).length === 1)
    expect(pressed(srv)).toEqual(['Ship'])
    await srv.close()
  }, 15000)

  // The first copy of a buttons edit reaches Telegram 12 s late, after the
  // 10-second limit gave up on it and after the repeat.
  const LATE = { method: 'editMessageReplyMarkup', has: 'Hold', times: 1, preMs: 12_000 }
  async function lateFirstCopy(repeat: string[][]) {
    const dir = state()
    const srv = await server(dir, { rules: [LATE] })
    const m = Number(/; buttons on message (\d+)$/.exec(ok(await tool(srv, 'reply', { chat_id: '1', text: 'Merge now?', buttons: [['Yes', 'No']] })))![1])
    expect(failed(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['Ship', 'Hold']] }, 15_000))).toBe(
      `edit_message: ${UNKNOWN_EDIT} (Telegram did not answer within 10 s)`)
    expect(ok(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), buttons: repeat }))).toBe(`edited (id: ${m})`)
    const edits = () => calls(dir).filter(c => c.method === 'editMessageReplyMarkup' && c.payload.message_id === m)
    await until(() => edits().length === 2, 6000)
    // The late first copy landed last, so the message shows it.
    const [repeated, first] = edits() as [Call, Call]
    expect(markupOf(first).inline_keyboard[0].map((b: any) => b.text)).toEqual(['Ship', 'Hold'])
    expect(shown(dir, m)).toEqual(markupOf(first))
    const p = press(m, 'Ship', markupOf(first))
    deliver(dir, [p.update])
    await until(() => answerOf(dir, p.id) !== undefined)
    await wait(500)
    return { srv, dir, first, repeated, p, pressed: pressed(srv) }
  }

  test('a repeated buttons edit with the same buttons, whose first copy lands late, carries the same keyboard, so a press on the late copy counts', async () => {
    const t = await lateFirstCopy([['Ship', 'Hold']])
    expect(markupOf(t.repeated)).toEqual(markupOf(t.first))
    expect(t.pressed).toEqual(['Ship'])
    expect(answerOf(t.dir, t.p.id)?.payload.text).toBeUndefined()
    await t.srv.close()
  }, 40000)

  test('a repeat with other buttons takes a new keyboard, so a press on the late first copy is refused as closed', async () => {
    const t = await lateFirstCopy([['Ship', 'Wait']])
    expect(markupOf(t.repeated)).not.toEqual(markupOf(t.first))
    expect(t.pressed).toEqual([])
    expect(answerOf(t.dir, t.p.id)?.payload.text).toBe(CLOSED)
    await t.srv.close()
  }, 40000)
})

describe.skipIf(process.platform !== 'linux')('calls after an update run beside polling', () => {
  const LONG_POLL = { TELEGRAM_TEST_LONG_POLL: '1' }
  const polls = (dir: string) => calls(dir).filter(c => c.method === 'getUpdates' && c.payload.timeout !== undefined)
  // The poll that asks past update id, which confirms it to Telegram.
  const confirming = (dir: string, id: number) => polls(dir).find(c => (c.payload.offset ?? 0) > id)

  // After a round whose Telegram call never gets an answer, the next poll
  // comes at once, and a text in the round after it reaches Claude.
  async function stillPolling(srv: Server, dir: string, round: object[], id: number) {
    const at = Date.now()
    if (round.length) deliver(dir, round)
    await until(() => confirming(dir, id) !== undefined, 1000)
    expect(confirming(dir, id)!.at - at).toBeLessThan(1000)
    deliver(dir, [dm(id + 1, OWNER, 'still heard')])
    await until(() => srv.inbound().some(n => n.content === 'still heard'), 2000)
  }

  test('a press whose answer and swap Telegram never answers leaves polling running, recorded before the next poll confirms it', async () => {
    const dir = state()
    const srv = await server(dir, { env: LONG_POLL, rules: [
      { method: 'answerCallbackQuery', hang: true },
      { method: 'editMessageReplyMarkup', has: 'disabled', hang: true },
    ] })
    const m = Number(/; buttons on message (\d+)$/.exec(ok(await tool(srv, 'reply', { chat_id: '1', text: 'Merge now?', buttons: [['Yes', 'No']] })))![1])
    const p = press(m, 'Yes', shown(dir, m))
    // While the test holds the button lock, the press cannot be recorded, so
    // no poll confirms it.
    const release = await lock(join(dir, 'buttons.lock'))
    deliver(dir, [{ update_id: 1, ...p.update }])
    await until(() => !existsSync(join(dir, 'inbound.json')), 1000)
    await wait(500)
    expect(confirming(dir, 1)).toBeUndefined()
    release()
    await stillPolling(srv, dir, [], 1)
    expect(confirming(dir, 1)!.taken).toEqual([`${m}:Yes`])
    expect(pressed(srv)).toEqual(['Yes'])
    expect(answerOf(dir, p.id)).toBeDefined()
    await srv.close()
  }, 20000)

  test('a command reply Telegram never answers leaves polling running', async () => {
    const dir = state()
    const srv = await server(dir, { env: LONG_POLL, rules: [{ method: 'sendMessage', has: 'bridges Telegram', hang: true }] })
    await stillPolling(srv, dir, [dm(1, OWNER, '/start', { entities: [{ type: 'bot_command', offset: 0, length: 6 }] })], 1)
    expect(sends(dir).some(c => String(c.payload.text).includes('bridges Telegram'))).toBe(true)
    await srv.close()
  }, 20000)

  test('a pairing reply Telegram never answers leaves polling running', async () => {
    const dir = state({ dmPolicy: 'pairing', allowFrom: ['1'], groups: {}, pending: {} })
    const srv = await server(dir, { env: { ...LONG_POLL, TELEGRAM_ACCESS_MODE: '' }, rules: [{ method: 'sendMessage', has: 'Pairing required', hang: true }] })
    await stillPolling(srv, dir, [dm(1, STRANGER, 'let me in')], 1)
    expect(sends(dir).some(c => String(c.payload.text).startsWith('Pairing required'))).toBe(true)
    await srv.close()
  }, 20000)

  test('See more then Allow: the two edits of one permission message reach Telegram in the order of their presses, while the answers and the decision wait for neither', async () => {
    const dir = state()
    const srv = await server(dir, { env: { ...LONG_POLL, TELEGRAM_ALERT_CHAT: '1' }, rules: [{ method: 'editMessageText', has: 'input_preview', holdMs: 3000 }] })
    srv.notify('notifications/claude/channel/permission_request', { request_id: 'abcde', tool_name: 'Write', description: 'Write a file', input_preview: '{"file_path":"/w/a.txt"}' })
    await until(() => sends(dir).some(c => c.payload.text === '🔐 Permission: Write'))
    const prompt = sends(dir).find(c => c.payload.text === '🔐 Permission: Write')!
    const tap = (id: string, data: string, keyboard: any) => ({ callback_query: { id, chat_instance: 'c', data, from: OWNER,
      message: { message_id: prompt.message_id, date: now(), chat: DM, text: '🔐 Permission: Write', reply_markup: keyboard } } })
    deliver(dir, [{ update_id: 1, ...tap('more', 'perm:more:abcde', markupOf(prompt)) }])
    const edits = () => calls(dir).filter(c => c.method === 'editMessageText' && c.payload.message_id === prompt.message_id)
    await until(() => edits().length === 1)
    const expanded = edits()[0]!
    const allow = { inline_keyboard: [[{ text: '✅ Allow', callback_data: 'perm:allow:abcde' }, { text: '❌ Deny', callback_data: 'perm:deny:abcde' }]] }
    const sent = Date.now()
    deliver(dir, [{ update_id: 2, ...tap('allow', 'perm:allow:abcde', allow) }])
    const decided = () => srv.notifications.some(n => n.method === 'notifications/claude/channel/permission' && n.params.behavior === 'allow')
    await until(() => decided() && answerOf(dir, 'allow') !== undefined, 1000)
    expect(answerOf(dir, 'allow')!.payload.text).toBe('✅ Allowed')
    expect(answerOf(dir, 'allow')!.at - sent).toBeLessThan(1000)
    await until(() => edits().length === 2, 6000)
    // Allow's edit goes once See more's edit has its answer, 3 s after it came.
    expect(edits()[1]!.payload.text).toBe('🔐 Permission: Write\n\n✅ Allowed')
    expect(edits()[1]!.at - expanded.at).toBeGreaterThanOrEqual(3000)
    await srv.close()
  }, 20000)
})
