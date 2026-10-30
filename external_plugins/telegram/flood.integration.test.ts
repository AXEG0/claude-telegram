// Every 429 any of the server's Telegram calls gets writes one flood control
// line to the log, naming the call, the chat and the wait (flood.ts), beside
// any line its caller already writes, in the running server. Only Telegram's
// HTTP is fake.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import fixture from './fixtures/channel-argv.json'
import { calls, cleanup, deliver, driveClock, start, state, until, wait, type Call, type Server } from './fixtures/harness.ts'
import { row, session, WAIT_MS } from './fixtures/session.ts'
import { apiError, toolCall, userText } from './fixtures/transcript.ts'
import { AGENT_TICK_MS, CHAT_GAP_MS } from './agents.ts'
import { REFRESH_MS } from './typing.ts'
import { FLOOD_LINE } from './flood.ts'

beforeEach(driveClock)
afterEach(cleanup)

const OWNER = { id: 1, is_bot: false, first_name: 'Owner', username: 'owner' }
const PEER = { id: 7080, is_bot: true, first_name: 'Peer', username: 'peer_eighty_bot' }
const now = () => Math.floor(Date.now() / 1000)
const tooMany = (n: number) => ({ error_code: 429, description: `Too Many Requests: retry after ${n}`, parameters: { retry_after: n } })
const PREFIX = `telegram channel: ${FLOOD_LINE}`
const floodLines = (srv: Server) => srv.stderr().split('\n').filter(l => l.startsWith(PREFIX))
// The one flood control line the server wrote, naming the call, the chat and
// the wait, with the hold's end.
function expectOneLine(srv: Server, method: string, chat: string, n: number): void {
  const lines = floodLines(srv)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toStartWith(`${PREFIX}${method} to chat ${chat}: 429, retry after ${n} s, held until `)
  expect(lines[0]).toMatch(/held until \d\d:\d\d:\d\d UTC \(Telegram: Too Many Requests: retry after \d+\)$/)
  expect(lines[0]).toEndWith(`(Telegram: Too Many Requests: retry after ${n})`)
}
const refused = (dir: string, method: string) => calls(dir).filter(c => c.method === method && c.refused)

type Options = { rules?: object[]; env?: Record<string, string>; argv?: string[] }
async function server(dir: string, o: Options = {}): Promise<Server> {
  const polling = !o.argv
  const srv = start(dir, o.argv ?? fixture.argv, { TELEGRAM_TEST_RULES: JSON.stringify(o.rules ?? []), ...o.env })
  await srv.ready()
  if (polling) await until(() => srv.stderr().includes('polling as '), 6000)
  return srv
}
const tool = async (srv: Server, name: string, args: object) => (await srv.request('tools/call', { name, arguments: args })).result
const text = (r: any): string => r.content[0].text
const ok = (r: any): string => {
  if (r.isError) throw new Error(`tool failed: ${text(r)}`)
  return text(r)
}

describe.skipIf(process.platform !== 'linux')('a flood control line for every 429', () => {
  test('a reply\'s text part', async () => {
    const dir = state()
    const srv = await server(dir, { rules: [{ method: 'sendMessage', has: 'hello', times: 1, error: tooMany(7) }] })
    const r = await tool(srv, 'reply', { chat_id: '1', text: 'hello' })
    expect(r.isError).toBe(true)
    expect(text(r)).toBe('reply failed: not sent; Telegram asks to wait 7 s (Telegram answered 429: Too Many Requests: retry after 7)')
    expectOneLine(srv, 'sendMessage', '1', 7)
    await srv.close()
  }, 15000)

  test('a reply\'s rich part', async () => {
    const dir = state()
    const srv = await server(dir, { env: { TELEGRAM_RICH_MESSAGES: 'true' }, rules: [{ method: 'sendRichMessage', times: 1, error: tooMany(8) }] })
    const r = await tool(srv, 'reply', { chat_id: '1', text: '**hello**' })
    expect(r.isError).toBe(true)
    expect(refused(dir, 'sendRichMessage')).toHaveLength(1)
    expectOneLine(srv, 'sendRichMessage', '1', 8)
    await srv.close()
  }, 15000)

  test.each([['a photo', 'sendPhoto', 'chart.png'], ['a document', 'sendDocument', 'notes.txt']])('a reply\'s file upload: %s', async (_name, method, file) => {
    const dir = state()
    mkdirSync(join(dir, 'inbox'))
    writeFileSync(join(dir, 'inbox', file), file)
    const srv = await server(dir, { rules: [{ method, times: 1, error: tooMany(9) }] })
    const r = await tool(srv, 'reply', { chat_id: '1', text: 'the file', files: [join(dir, 'inbox', file)] })
    expect(r.isError).toBe(true)
    expect(refused(dir, method)).toHaveLength(1)
    expectOneLine(srv, method, '1', 9)
    await srv.close()
  }, 15000)

  test('a reply\'s album to another bot, its chat named by @username', async () => {
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1', String(PEER.id)] })
    mkdirSync(join(dir, 'inbox'))
    for (const f of ['a.txt', 'b.txt']) writeFileSync(join(dir, 'inbox', f), f)
    const srv = await server(dir, {
      argv: ['claude', '-p', 'hello'],
      env: { TELEGRAM_TEST_USERS: JSON.stringify({ [PEER.id]: PEER }) },
      rules: [{ method: 'sendMediaGroup', times: 1, error: tooMany(11) }],
    })
    const r = await tool(srv, 'reply', { chat_id: String(PEER.id), text: 'the files', files: [join(dir, 'inbox', 'a.txt'), join(dir, 'inbox', 'b.txt')] })
    expect(r.isError).toBe(true)
    expect(refused(dir, 'sendMediaGroup').map(c => c.payload.chat_id)).toEqual([`@${PEER.username}`])
    expectOneLine(srv, 'sendMediaGroup', `@${PEER.username}`, 11)
    await srv.close()
  }, 15000)

  test('edit_message\'s text edit', async () => {
    const dir = state()
    const srv = await server(dir, { rules: [{ method: 'editMessageText', has: 'later', times: 1, error: tooMany(5) }] })
    const m = /^sent \(id: (\d+)\)$/.exec(ok(await tool(srv, 'reply', { chat_id: '1', text: 'working' })))![1]
    const r = await tool(srv, 'edit_message', { chat_id: '1', message_id: m, text: 'later' })
    expect(text(r)).toBe('edit_message failed: not edited; Telegram asks to wait 5 s (Telegram answered 429: Too Many Requests: retry after 5)')
    expectOneLine(srv, 'editMessageText', '1', 5)
    await srv.close()
  }, 15000)

  test('edit_message\'s buttons-only edit', async () => {
    const dir = state()
    const srv = await server(dir, { rules: [{ method: 'editMessageReplyMarkup', has: 'Ship', times: 1, error: tooMany(6) }] })
    const m = /; buttons on message (\d+)$/.exec(ok(await tool(srv, 'reply', { chat_id: '1', text: 'Merge now?', buttons: [['Yes', 'No']] })))![1]
    const r = await tool(srv, 'edit_message', { chat_id: '1', message_id: m, buttons: [['Ship', 'Hold']] })
    expect(r.isError).toBe(true)
    expect(refused(dir, 'editMessageReplyMarkup')).toHaveLength(1)
    expectOneLine(srv, 'editMessageReplyMarkup', '1', 6)
    await srv.close()
  }, 15000)

  test('the react tool', async () => {
    const dir = state()
    const srv = await server(dir, { rules: [{ method: 'setMessageReaction', times: 1, error: tooMany(4) }] })
    const r = await tool(srv, 'react', { chat_id: '1', message_id: '5', emoji: '👍' })
    expect(r.isError).toBe(true)
    expectOneLine(srv, 'setMessageReaction', '1', 4)
    await srv.close()
  }, 15000)

  test('typing', async () => {
    const dir = state()
    deliver(dir, [{ message: { message_id: 1, date: now(), from: OWNER, chat: { id: 1, type: 'private' }, text: 'typing test' } }])
    const srv = await server(dir, { rules: [{ method: 'sendChatAction', times: 1, error: tooMany(3) }] })
    await until(() => refused(dir, 'sendChatAction').length === 1, REFRESH_MS + 4000)
    await wait(500)
    expectOneLine(srv, 'sendChatAction', '1', 3)
    await srv.close()
  }, 15000)

  // The first update the server handles, so its reply goes through the API
  // grammY gives that update, never one made after it.
  test('a command reply, through the update\'s own API, beside its own line', async () => {
    const dir = state()
    deliver(dir, [{ message: { message_id: 1, date: now(), from: OWNER, chat: { id: 1, type: 'private' }, text: '/help', entities: [{ type: 'bot_command', offset: 0, length: 5 }] } }])
    const srv = await server(dir, { rules: [{ method: 'sendMessage', has: 'Messages you send here', times: 1, error: tooMany(12) }] })
    await until(() => srv.stderr().includes('/help reply not sent'), 6000)
    expect(srv.stderr()).toContain('telegram channel: /help reply not sent: Call to \'sendMessage\' failed! (429: Too Many Requests: retry after 12)')
    expectOneLine(srv, 'sendMessage', '1', 12)
    await srv.close()
  }, 15000)

  test('a poll, which names no chat, beside the poll\'s own line', async () => {
    const dir = state()
    const srv = await server(dir, { rules: [{ method: 'getUpdates', times: 1, error: tooMany(1) }] })
    await until(() => calls(dir).filter(c => c.method === 'getUpdates').length >= 2, 6000)
    expect(srv.stderr()).toMatch(/telegram channel: poll failed after \d+\.\d s: 429: Too Many Requests: retry after 1\n/)
    expect(floodLines(srv)).toEqual([`${PREFIX}getUpdates to no chat: 429, retry after 1 s, nothing held (Telegram: Too Many Requests: retry after 1)`])
    await srv.close()
  }, 15000)
})

describe.skipIf(process.platform !== 'linux')('a flood control line for every 429 of the subagents message', () => {
  test('its first send', async () => {
    const s = await session({ TELEGRAM_TEST_RULES: JSON.stringify([{ method: 'sendMessage', has: '🤖 Subagents', times: 1, error: tooMany(5) }]) })
    s.begin('a1', 'Long job')
    await until(() => refused(s.dir, 'sendMessage').length === 1, WAIT_MS)
    await wait(200)
    expectOneLine(s.channel, 'sendMessage', '1', 5)
    await s.channel.close()
  }, 30000)

  test('its edit', async () => {
    const s = await session({ TELEGRAM_TEST_RULES: JSON.stringify([{ method: 'editMessageText', has: '🤖 Subagents', times: 1, error: tooMany(5) }]) })
    s.begin('a1', 'Long job')
    await s.next(t => row(t, 1).startsWith('1. ⏳'))
    s.write('a1', toolCall('c1', Date.now(), 'Checking gate', 900))
    await until(() => refused(s.dir, 'editMessageText').length === 1, WAIT_MS)
    await wait(200)
    expectOneLine(s.channel, 'editMessageText', '1', 5)
    await s.channel.close()
  }, 30000)

  // A row its transcript closed as failed ends the group; its stop hook then
  // owes the ended group's message one more edit.
  test('a late edit', async () => {
    const s = await session({ TELEGRAM_TEST_RULES: JSON.stringify([{ method: 'editMessageText', has: '✅ Done', times: 1, error: tooMany(5) }]) })
    s.begin('a1', 'Long job')
    s.write('a1', userText('u1', Date.now(), 'Long job'))
    const sent = await s.next(t => row(t, 1).startsWith('1. ⏳'))
    const recorded = () => readdirSync(join(s.dir, 'panels')).some(n => n.endsWith('.json'))
    await until(recorded)
    await wait(CHAT_GAP_MS)
    s.write('a1', apiError('e1', Date.now(), 'overloaded'))
    await s.next(t => row(t, 1).startsWith('1. ❌ Failed'))
    // The next tick confirms the failure and ends the group, whose message
    // then needs no closing, so its record goes.
    await until(() => !recorded(), 2 * AGENT_TICK_MS + 2000)
    s.stop('a1')
    await until(() => refused(s.dir, 'editMessageText').length === 1, WAIT_MS)
    const late = refused(s.dir, 'editMessageText')[0]!
    expect(late.payload.message_id).toBe(sent.message_id)
    expect(row(late.payload.text, 1)).toStartWith('1. ✅ Done in')
    await wait(200)
    expectOneLine(s.channel, 'editMessageText', '1', 5)
    await s.channel.close()
  }, 30000)

  test('the sweep of a gone server\'s message', async () => {
    const dir = state()
    mkdirSync(join(dir, 'panels'), { recursive: true })
    const writer = `${'ab'.repeat(7)}06`
    writeFileSync(join(dir, 'panels', '1-501.json'), JSON.stringify({ chat: '1', message: 501, text: '🤖 Subagents\n1. 🔌 swept', writer }))
    writeFileSync(join(dir, 'panels', `${writer}.lock`), '')
    const next = start(dir, fixture.argv, { TELEGRAM_TEST_RULES: JSON.stringify([{ method: 'editMessageText', times: 1, error: tooMany(1) }]) })
    await next.ready()
    await until(() => calls(dir).some((c: Call) => c.method === 'editMessageText' && c.payload.message_id === 501 && c.refused), WAIT_MS)
    await wait(200)
    expectOneLine(next, 'editMessageText', '1', 1)
    await next.close()
  }, 30000)
})
