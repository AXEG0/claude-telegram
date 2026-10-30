// After a 429 on a chat, typing and the subagents message send nothing to that
// chat until its retry_after ends, then resume (flood.ts), whichever call met
// the wait; every other call still reaches Telegram. In the running server on
// the driven clock; only Telegram's HTTP is fake.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import fixture from './fixtures/channel-argv.json'
import { calls, cleanup, deliver, driveClock, start, state, until, wait, type Call, type Server } from './fixtures/harness.ts'
import { isPanel } from './fixtures/session.ts'
import { AGENT_TICK_MS, agentEventFile, appendAgentEvent } from './agents.ts'
import { REFRESH_MS } from './typing.ts'

beforeEach(driveClock)
afterEach(cleanup)

const OWNER = { id: 1, is_bot: false, first_name: 'Owner', username: 'owner' }
const PEER = { id: 7080, is_bot: true, first_name: 'Peer', username: 'peer_eighty_bot' }
const now = () => Math.floor(Date.now() / 1000)
// The wait every refusal below asks for, in seconds.
const WAIT_S = 30
const tooMany = (n: number) => ({ error_code: 429, description: `Too Many Requests: retry after ${n}`, parameters: { retry_after: n } })
// The fake logs a call a few milliseconds after the server's timer made it.
const SLACK_MS = 50

const dmFrom = (from: { id: number }, text: string) =>
  ({ message: { message_id: 1, date: now(), from, chat: { id: from.id, type: 'private' }, text } })
const reactionFrom = (from: { id: number }, message_id: number) =>
  ({ message_reaction: { chat: { id: from.id, type: 'private' }, message_id, user: from, date: now(), old_reaction: [], new_reaction: [{ type: 'emoji', emoji: '👍' }] } })

// A polling server whose first update is the one given, which starts the
// turn's typing in its chat, with a subagent's start for the subagents message.
async function channel(o: { first: object; access?: object; env?: Record<string, string> }) {
  const dir = state(o.access)
  deliver(dir, [o.first])
  const srv = start(dir, fixture.argv, o.env ?? {})
  await srv.ready()
  await until(() => srv.inbound().length === 1, 6000)
  const base = join(dir, 'transcripts')
  mkdirSync(base, { recursive: true })
  const begin = (id: string) => {
    writeFileSync(join(base, `agent-${id}.meta.json`), JSON.stringify({ description: 'Long job' }))
    writeFileSync(join(base, `agent-${id}.jsonl`), '')
    appendAgentEvent(agentEventFile(dir, srv.child.pid!), { t: Date.now(), event: 'start', agent_id: id, agent_type: 'general-purpose', agent_base: join(base, `agent-${id}`) })
  }
  return { dir, srv, begin }
}
const rules = (...list: object[]) => ({ TELEGRAM_TEST_RULES: JSON.stringify(list) })
const tool = async (srv: Server, name: string, args: object) => (await srv.request('tools/call', { name, arguments: args })).result
const typingTo = (chat: string) => (c: Call) => c.method === 'sendChatAction' && String(c.payload.chat_id) === chat
const panelTo = (chat: string) => (c: Call) => isPanel(c) && String(c.payload.chat_id) === chat
// The index in the fake's log of the first call that matches.
async function entryOf(dir: string, match: (c: Call) => boolean, timeout: number): Promise<number> {
  await until(() => calls(dir).some(match), timeout)
  return calls(dir).findIndex(match)
}
// The subagents message's first send in chat 1, with typing running there.
async function streaming(dir: string): Promise<void> {
  await until(() => calls(dir).some(panelTo('1')) && calls(dir).some(typingTo('1')), AGENT_TICK_MS + 4000)
}

// From just after the refused call's entry until its time plus the wait,
// typing and, where it runs there, the subagents message make no call to the
// chat; each makes one within its own interval once the wait ends.
async function expectHeld(dir: string, index: number, chat: string, panel: boolean): Promise<void> {
  const from = calls(dir)[index]!.at
  const end = from + WAIT_S * 1000
  const after = () => calls(dir).slice(index + 1)
  await wait(end - Date.now())
  const kinds = panel ? [typingTo(chat), panelTo(chat)] : [typingTo(chat)]
  for (const kind of kinds) expect(after().filter(c => c.at < end && kind(c))).toEqual([])
  await until(() => after().some(c => c.at >= end && typingTo(chat)(c)), REFRESH_MS + 1000)
  expect(after().find(c => c.at >= end && typingTo(chat)(c))!.at).toBeLessThanOrEqual(end + REFRESH_MS + SLACK_MS)
  if (!panel) return
  await until(() => after().some(c => c.at >= end && panelTo(chat)(c)), AGENT_TICK_MS + 1000)
  expect(after().find(c => c.at >= end && panelTo(chat)(c))!.at).toBeLessThanOrEqual(end + AGENT_TICK_MS + SLACK_MS)
}

describe.skipIf(process.platform !== 'linux')('a held chat gets no typing and no subagents message until its wait ends', () => {
  test('held by typing\'s own 429; a reply sent meanwhile still reaches Telegram once and says not sent', async () => {
    const { dir, srv, begin } = await channel({ first: dmFrom(OWNER, 'hold test'), env: rules(
      { method: 'sendChatAction', skip: 3, times: 1, error: tooMany(WAIT_S) },
      { method: 'sendMessage', has: 'during the hold', times: 1, error: tooMany(20) },
    ) })
    begin('a1')
    await streaming(dir)
    const index = await entryOf(dir, c => typingTo('1')(c) && !!c.refused, 4 * REFRESH_MS + 2000)
    await wait(5000)
    const r = await tool(srv, 'reply', { chat_id: '1', text: 'during the hold' })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toBe('reply failed: not sent; Telegram asks to wait 20 s (Telegram answered 429: Too Many Requests: retry after 20)')
    expect(calls(dir).filter(c => c.method === 'sendMessage' && c.payload.text === 'during the hold')).toHaveLength(1)
    await expectHeld(dir, index, '1', true)
    await srv.close()
  }, 60000)

  test('held by a reply\'s 429', async () => {
    const { dir, srv, begin } = await channel({ first: dmFrom(OWNER, 'hold test'), env: rules(
      { method: 'sendMessage', has: 'held reply', times: 1, error: tooMany(WAIT_S) },
    ) })
    begin('a1')
    await streaming(dir)
    expect((await tool(srv, 'reply', { chat_id: '1', text: 'held reply' })).isError).toBe(true)
    const index = calls(dir).findIndex(c => c.method === 'sendMessage' && !!c.refused)
    await expectHeld(dir, index, '1', true)
    await srv.close()
  }, 60000)

  test('held by the subagents message\'s own 429', async () => {
    const { dir, srv, begin } = await channel({ first: dmFrom(OWNER, 'hold test'), env: rules(
      { method: 'editMessageText', has: '🤖 Subagents', times: 1, error: tooMany(WAIT_S) },
    ) })
    begin('a1')
    await streaming(dir)
    const index = await entryOf(dir, c => panelTo('1')(c) && !!c.refused, 4 * AGENT_TICK_MS + 2000)
    await expectHeld(dir, index, '1', true)
    await srv.close()
  }, 60000)

  // A reaction starts the turn without the server learning who the chat is,
  // so a reply there asks Telegram first, and that read meets the 429.
  test('held by a read\'s 429: the bot lookup for a reply', async () => {
    const { dir, srv, begin } = await channel({ first: reactionFrom(OWNER, 77), env: {
      TELEGRAM_TEST_CHATS: JSON.stringify({ flood: { 1: WAIT_S } }),
    } })
    begin('a1')
    await streaming(dir)
    const r = await tool(srv, 'reply', { chat_id: '1', text: 'after the reaction' })
    expect(r.isError).toBe(true)
    expect(calls(dir).filter(c => c.method === 'sendMessage' && c.payload.text === 'after the reaction')).toEqual([])
    const index = calls(dir).findIndex(c => c.method === 'getChatMember' && String(c.payload.chat_id) === '1')
    expect(index).toBeGreaterThan(-1)
    await expectHeld(dir, index, '1', true)
    await srv.close()
  }, 60000)

  test('a 429 in another chat holds nothing in this one', async () => {
    const { dir, srv, begin } = await channel({ first: dmFrom(OWNER, 'hold test'), access: { dmPolicy: 'allowlist', allowFrom: ['1', '2'] }, env: rules(
      { method: 'sendMessage', has: 'other chat', times: 1, error: tooMany(WAIT_S) },
    ) })
    begin('a1')
    await streaming(dir)
    expect((await tool(srv, 'reply', { chat_id: '2', text: 'other chat' })).isError).toBe(true)
    const index = calls(dir).findIndex(c => c.method === 'sendMessage' && !!c.refused)
    expect(String(calls(dir)[index]!.payload.chat_id)).toBe('2')
    const end = calls(dir)[index]!.at + WAIT_S * 1000
    await wait(end - Date.now())
    const during = calls(dir).slice(index + 1).filter(c => c.at < end)
    expect(during.filter(typingTo('1')).length).toBeGreaterThanOrEqual(WAIT_S * 1000 / REFRESH_MS - 1)
    expect(during.filter(panelTo('1')).length).toBeGreaterThanOrEqual(2)
    expect(srv.stderr()).toContain('telegram channel: flood control on sendMessage to chat 2: 429, retry after 30 s, held until ')
    await srv.close()
  }, 60000)

  // Typing goes to a bot's numeric chat, while a reply to it goes by its
  // @username, so the reply's 429 holds that name.
  test('a bot\'s chat, held under its @username by a reply\'s 429, gets no typing under its id', async () => {
    const { dir, srv } = await channel({ first: dmFrom(PEER, 'from the other bot'), access: { dmPolicy: 'allowlist', allowFrom: ['1', String(PEER.id)] }, env: rules(
      { method: 'sendMessage', has: PEER.username, times: 1, error: tooMany(WAIT_S) },
    ) })
    await until(() => calls(dir).some(typingTo(String(PEER.id))), REFRESH_MS + 2000)
    expect((await tool(srv, 'reply', { chat_id: String(PEER.id), text: 'to the bot' })).isError).toBe(true)
    const index = calls(dir).findIndex(c => c.method === 'sendMessage' && !!c.refused)
    expect(calls(dir)[index]!.payload.chat_id).toBe(`@${PEER.username}`)
    await expectHeld(dir, index, String(PEER.id), false)
    await srv.close()
  }, 60000)
})
