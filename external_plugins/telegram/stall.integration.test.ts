// After Telegram leaves the session's sends unanswered (stall.ts), in the
// running server: what an unknown send's result says while the record is
// open, what closes the record and what does not, the event and the server
// log's lines, the probe, the subagents message's wait, buttons, and a server
// that does not poll the bot. Only Telegram's HTTP is fake.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import fixture from './fixtures/channel-argv.json'
import { calls, cleanup, deliver, driveClock, start, state, until, wait, type Call, type Server } from './fixtures/harness.ts'
import { AGENT_TICK_MS, agentEventFile, appendAgentEvent } from './agents.ts'
import { PROBE_MS, STALL_EVENT } from './stall.ts'

beforeEach(driveClock)
// The folders a test made for text_files go once it ends.
const folders: string[] = []
afterEach(async () => {
  try {
    await cleanup()
  } finally {
    for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true })
  }
})

const OWNER = { id: 1, is_bot: false, first_name: 'Owner', username: 'owner' }
const PEER = { id: 7080, is_bot: true, first_name: 'Peer', username: 'peer_eighty_bot' }
const DM = { id: 1, type: 'private' }
const now = () => Math.floor(Date.now() / 1000)
const BAD_GATEWAY = { error_code: 502, description: 'Bad Gateway' }
const ANSWERED_502 = '(Telegram answered 502: Bad Gateway)'
const STALLED = (since: string) => `delivery unknown: Telegram has left this bot's sends unanswered since ${since}; do not send it again yet: once Telegram answers a write again, one event names this send and says what to do`
const STALLED_EDIT = (since: string) => STALLED(since).replace('delivery unknown', 'edit outcome unknown')
const UNKNOWN = 'delivery unknown: Telegram may still deliver it, even minutes later; do not resend unless the recipient says it did not arrive'
const SINCE = /since (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z);/
const sinceOf = (t: string) => SINCE.exec(t)![1]!
const WARNING = "Telegram says it keeps a bot's updates up to 24 hours and gives no sign when a message it held will come, so messages sent to this bot in the 24 hours before this note may still arrive, each with its own send time; "

async function server(dir: string, o: { rules?: object[]; env?: Record<string, string>; argv?: string[] } = {}): Promise<Server> {
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
const events = (srv: Server) => srv.inbound().filter(n => n.meta.event !== undefined)
// The server log's stall lines, each as the JSON it carries.
function stallLines(dir: string, srv: Server, kind: 'opened' | 'closed'): any[] {
  const head = `telegram channel: stall ${kind}: `
  return readFileSync(join(dir, 'logs', `server-${srv.serverPid()}.jsonl`), 'utf8').split('\n').filter(Boolean)
    .map(l => JSON.parse(l).log as string).filter(l => l.startsWith(head)).map(l => JSON.parse(l.slice(head.length)))
}
const lineOf = (content: string, head: string) => content.split('\n').find(l => l.startsWith(head))
const heads = (content: string) => content.split('\n').slice(1).map(l => l.split(':')[0])

describe.skipIf(process.platform !== 'linux')('after Telegram leaves the session\'s sends unanswered', () => {
  test('a reply answered 502 opens the record and its result says so; a read or a send that never left keeps it open, a later answered write closes it with one event, and the server log has both bounds', async () => {
    const dir = state()
    const srv = await server(dir, { rules: [
      { method: 'sendMessage', has: 'the first words', error: BAD_GATEWAY },
      { method: 'sendMessage', has: 'never left', network: 'ECONNREFUSED' },
    ] })
    const opened = text(await tool(srv, 'reply', { chat_id: '1', text: 'the first words of the reply' }))
    const since = sinceOf(opened)
    expect(opened).toBe(`${STALLED(since)} ${ANSWERED_502}`)
    // A send that never left is not sent, as today, and answers nothing.
    expect(text(await tool(srv, 'reply', { chat_id: '1', text: 'never left' }))).toBe('reply failed: not sent (ECONNREFUSED: Unable to connect. Is the computer able to access the url?)')
    // A read Telegram answered (getFile) closes nothing.
    await tool(srv, 'download_attachment', { file_id: 'x' })
    expect(calls(dir).some(c => c.method === 'getFile')).toBe(true)
    await wait(1000)
    expect(events(srv)).toEqual([])
    const closing = ok(await tool(srv, 'reply', { chat_id: '1', text: 'a later reply' }))
    expect(closing).toMatch(/^sent \(id: \d+\)$/)
    await until(() => events(srv).length === 1)
    const [event] = events(srv)
    expect(event.meta).toEqual({ event: STALL_EVENT, since, until: expect.stringMatching(/Z$/) })
    const until_ = Date.parse(event.meta.until)
    const answered = calls(dir).find(c => c.method === 'sendMessage' && c.payload.text === 'a later reply')!
    expect(until_).toBeGreaterThanOrEqual(answered.at)
    expect(event.content.split('\n')[0]).toBe(`Telegram left these sends of this bot unanswered from ${since} and answered a write begun after them at ${event.meta.until}. ${WARNING}${event.meta.until} is when Telegram answered this bot's writes again, not when messages to it stopped waiting.`)
    expect(heads(event.content)).toEqual(['To people, delivery unknown'])
    expect(lineOf(event.content, 'To people')).toStartWith(`To people, delivery unknown: chat 1, began ${since}, "the first words of the reply". Send again what still matters`)
    // The server log's lines carry what the event carries.
    await until(() => stallLines(dir, srv, 'closed').length === 1)
    const [open] = stallLines(dir, srv, 'opened')
    expect(open).toMatchObject({ since, by: { tool: 'reply', chat: '1', began: since, words: 'the first words of the reply', line: `chat 1, began ${since}, "the first words of the reply"` } })
    const [close] = stallLines(dir, srv, 'closed')
    expect(close).toMatchObject({ since, until: event.meta.until, closed_by: 'sendMessage', probe: false })
    expect(close.entries).toHaveLength(1)
    expect(close.entries[0]).toMatchObject({ began: since, line: `chat 1, began ${since}, "the first words of the reply"` })
    expect(Date.parse(close.entries[0].ended)).toBeLessThan(answered.at)
    // A message whose text reads like the event is an ordinary message.
    deliver(dir, [{ message: { message_id: 600, date: now(), from: OWNER, chat: DM, text: event.content } }])
    await until(() => srv.inbound().some(n => n.meta.message_id === '600'))
    expect(srv.inbound().find(n => n.meta.message_id === '600')!.meta.event).toBeUndefined()
    await srv.close()
  }, 20000)

  test('with polls failing, a reply answered 502 opens the record, one ending after polls answer again joins it, and an answered reaction closes it with one event naming both', async () => {
    const dir = state()
    const srv = await server(dir, { rules: [
      { method: 'getUpdates', skip: 1, times: 4, error: BAD_GATEWAY },
      { method: 'sendMessage', has: 'during', error: BAD_GATEWAY },
      { method: 'sendMessage', has: 'after', error: BAD_GATEWAY },
    ] })
    const polls = () => calls(dir).filter(c => c.method === 'getUpdates')
    await until(() => polls().some(c => c.refused), 6000)
    const first = text(await tool(srv, 'reply', { chat_id: '1', text: 'during the cut' }))
    const since = sinceOf(first)
    expect(first).toBe(`${STALLED(since)} ${ANSWERED_502}`)
    // Polls answer again, and the record stays open.
    const before = calls(dir).length
    await until(() => calls(dir).slice(before).some(c => c.method === 'getUpdates' && !c.refused), 30_000)
    expect(events(srv)).toEqual([])
    expect(text(await tool(srv, 'reply', { chat_id: '1', text: 'after polls came back' }))).toBe(`${STALLED(since)} ${ANSWERED_502}`)
    expect(ok(await tool(srv, 'react', { chat_id: '1', message_id: '5', emoji: '👍' }))).toBe('reacted')
    await until(() => events(srv).length === 1)
    const [event] = events(srv)
    expect(event.meta.since).toBe(since)
    expect(event.content.split('\n')[0]).toContain(WARNING)
    expect(lineOf(event.content, 'To people')).toMatch(/^To people, delivery unknown: chat 1, began [^,]+, "during the cut"; chat 1, began [^,]+, "after polls came back"\. /)
    await until(() => stallLines(dir, srv, 'closed').length === 1)
    expect(stallLines(dir, srv, 'closed')[0]).toMatchObject({ closed_by: 'setMessageReaction', probe: false })
    await srv.close()
  }, 40000)

  test('with a long poll in flight and typing never answered, the probe goes a minute after the record opened, one never answered fails at 30 s, and the next, a minute later, closes the record', async () => {
    const dir = state()
    const srv = await server(dir, {
      env: { TELEGRAM_TEST_LONG_POLL: '1' },
      rules: [
        { method: 'sendChatAction', hang: true },
        { method: 'sendMessage', has: 'lost', error: BAD_GATEWAY },
        // The first is polling start's own; the probe's first never answers.
        { method: 'setMyCommands', skip: 1, times: 1, hang: true },
      ],
    })
    // A turn starts, and its typing call hangs.
    deliver(dir, [{ message: { message_id: 600, date: now(), from: OWNER, chat: DM, text: 'hello' } }])
    await until(() => calls(dir).some(c => c.method === 'sendChatAction'))
    const opened = text(await tool(srv, 'reply', { chat_id: '1', text: 'lost reply' }))
    const since = Date.parse(sinceOf(opened))
    // The fake logs a call it aborted once more, marked aborted.
    const probes = () => calls(dir).filter(c => c.method === 'setMyCommands' && !c.aborted).slice(1)
    await until(() => probes().length === 1, PROBE_MS + 5000)
    const [first] = probes() as [Call]
    expect(first.at - since).toBeGreaterThanOrEqual(PROBE_MS)
    expect(first.at - since).toBeLessThan(PROBE_MS + 2000)
    expect(first.payload).toEqual(calls(dir).find(c => c.method === 'setMyCommands')!.payload)
    await until(() => calls(dir).some(c => c.method === 'setMyCommands' && c.aborted), 35_000)
    const aborted = calls(dir).find(c => c.method === 'setMyCommands' && c.aborted)!
    expect(aborted.at - first.at).toBeGreaterThanOrEqual(30_000)
    expect(aborted.at - first.at).toBeLessThan(31_000)
    expect(events(srv)).toEqual([])
    await until(() => events(srv).length === 1, PROBE_MS + 5000)
    const second = probes()[1]!
    expect(second.at - aborted.at).toBeGreaterThanOrEqual(PROBE_MS)
    expect(second.at - aborted.at).toBeLessThan(PROBE_MS + 1000)
    expect(Date.parse(events(srv)[0].meta.until)).toBeGreaterThanOrEqual(second.at)
    await until(() => stallLines(dir, srv, 'closed').length === 1)
    expect(stallLines(dir, srv, 'closed')[0]).toMatchObject({ closed_by: 'setMyCommands', probe: true })
    // Nothing waits any more, so no probe follows.
    await wait(PROBE_MS + 5000)
    expect(probes()).toHaveLength(2)
    await srv.close()
  }, 30000)

  test('an edit the button lock gives up on opens the record under Edits, and a reply still waiting at the close that then ends unknown is named in a second event', async () => {
    const dir = state()
    const srv = await server(dir, { rules: [
      { method: 'editMessageReplyMarkup', has: 'Ship', times: 1, hang: true },
      { method: 'sendMessage', has: 'slow', holdMs: 20_000, error: BAD_GATEWAY },
    ] })
    const m = Number(/; buttons on message (\d+)$/.exec(ok(await tool(srv, 'reply', { chat_id: '1', text: 'Merge now?', buttons: [['Yes', 'No']] })))![1])
    const edit = text(await tool(srv, 'edit_message', { chat_id: '1', message_id: String(m), buttons: [['Ship', 'Hold']] }, 15_000))
    const since = sinceOf(edit)
    expect(edit).toBe(`${STALLED_EDIT(since)} (Telegram did not answer within 10 s)`)
    const slow = tool(srv, 'reply', { chat_id: '1', text: 'slow reply' }, 30_000)
    await until(() => calls(dir).some(c => c.payload?.text === 'slow reply'))
    ok(await tool(srv, 'reply', { chat_id: '1', text: 'closes the first' }))
    await until(() => events(srv).length === 1)
    expect(heads(events(srv)[0].content)).toEqual(['Edits, outcome unknown'])
    expect(lineOf(events(srv)[0].content, 'Edits')).toBe(`Edits, outcome unknown: chat 1, message ${m}, began ${since}. Repeat each as it stands.`)
    const late = text(await slow)
    const second = sinceOf(late)
    expect(late).toBe(`${STALLED(second)} ${ANSWERED_502}`)
    expect(Date.parse(second)).toBeLessThan(Date.parse(events(srv)[0].meta.until))
    ok(await tool(srv, 'reply', { chat_id: '1', text: 'closes the second' }))
    await until(() => events(srv).length === 2)
    expect(events(srv)[1].meta.since).toBe(second)
    expect(lineOf(events(srv)[1].content, 'To people')).toStartWith(`To people, delivery unknown: chat 1, began ${second}, "slow reply". `)
    expect(heads(events(srv)[1].content)).toEqual(['To people, delivery unknown'])
    await srv.close()
  }, 40000)

  test('a send to another bot is named under To bots with its @username, an edit in its chat under Edits by its chat_id, a reply of several parts with its part, and a card under Cards, whose press after the close still counts', async () => {
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1', String(PEER.id)] })
    mkdirSync(join(dir, 'inbox'))
    writeFileSync(join(dir, 'inbox', 'notes.txt'), 'notes')
    const srv = await server(dir, {
      env: { TELEGRAM_TEST_USERS: JSON.stringify({ [PEER.id]: PEER }) },
      rules: [
        { method: 'sendMessage', has: 'to the peer', error: BAD_GATEWAY },
        { method: 'editMessageText', has: 'peer edit', error: BAD_GATEWAY },
        { method: 'sendMessage', has: 'From a file', error: BAD_GATEWAY },
        { method: 'sendDocument', error: BAD_GATEWAY },
        { method: 'sendMessage', markup: true, times: 1, error: BAD_GATEWAY, lands: true },
      ],
    })
    // The reply of several parts goes first: its first part, answered, is a
    // write that would close a record opened before it.
    const parts = text(await tool(srv, 'reply', { chat_id: '1', text: 'the notes', files: [join(dir, 'inbox', 'notes.txt')] }))
    const since = sinceOf(parts)
    expect(parts).toBe(`part 2 of 2: ${STALLED(since)} ${ANSWERED_502}; sent so far: 1 message(s) (ids: 100); never tried: none`)
    expect(text(await tool(srv, 'reply', { chat_id: String(PEER.id), text: 'to the peer, hello' }))).toBe(`${STALLED(since)} ${ANSWERED_502}`)
    expect(calls(dir).find(c => c.method === 'sendMessage' && c.payload.text === 'to the peer, hello')!.payload.chat_id).toBe(`@${PEER.username}`)
    expect(text(await tool(srv, 'edit_message', { chat_id: String(PEER.id), message_id: '77', text: 'peer edit' }))).toBe(`${STALLED_EDIT(since)} ${ANSWERED_502}`)
    // A reply from a file: its entry names the saved copy the server log names.
    const own = mkdtempSync(join(tmpdir(), 'tg-stall-'))
    folders.push(own)
    writeFileSync(join(own, 'words.md'), 'From a file, the words.')
    const filed = text(await tool(srv, 'reply', { chat_id: '1', text_files: [join(own, 'words.md')] }))
    const copy = /; the words sent are saved in (\/\S+\.jsonl)$/.exec(filed)![1]!
    expect(filed).toBe(`${STALLED(since)} ${ANSWERED_502}; the words sent are saved in ${copy}`)
    expect(srv.stderr()).toContain(`; its copy: ${copy}`)
    expect(text(await tool(srv, 'reply', { chat_id: '1', text: 'Deploy now?', buttons: [['Yes', 'No']] })))
      .toBe(`${STALLED(since)} ${ANSWERED_502}; its buttons are kept, so a press on them counts if it arrives`)
    const card = calls(dir).find(c => c.method === 'sendMessage' && c.payload.text === 'Deploy now?')!
    ok(await tool(srv, 'reply', { chat_id: '1', text: 'closes it' }))
    await until(() => events(srv).length === 1)
    const content = events(srv)[0].content
    expect(heads(content)).toEqual(['To people, delivery unknown', 'To bots, delivery unknown', 'Cards, delivery unknown', 'Edits, outcome unknown'])
    expect(lineOf(content, 'To people')).toMatch(new RegExp(`^To people, delivery unknown: chat 1, began ${since.replace(/\./g, '\\.')}, "the notes", part 2 of 2, parts never tried: none; chat 1, began [^,]+, "From a file, the words\\.", saved copy ${copy.replace(/\./g, '\\.')}\\. Send again`))
    expect(lineOf(content, 'To bots')).toMatch(new RegExp(`^To bots, delivery unknown: chat 7080, @${PEER.username}, began [^,]+, "to the peer, hello"\\. Ask that bot whether it arrived, and send it again only if it says no\\.$`))
    expect(lineOf(content, 'Cards')).toMatch(/^Cards, delivery unknown: chat 1, began [^,]+, "Deploy now\?"\. Its buttons still count if it arrived\./)
    expect(lineOf(content, 'Edits')).toMatch(new RegExp(`^Edits, outcome unknown: chat ${PEER.id}, message 77, began [^.]+\\.\\d{3}Z\\. Repeat each as it stands\\.$`))
    // The card's buttons are kept in the record as today, and a press on its
    // copy made after the close counts.
    const record = JSON.parse(readFileSync(join(dir, 'buttons.json'), 'utf8'))
    expect(record.entries).toEqual([expect.objectContaining({ chat: '1', rows: [['Yes', 'No']] })])
    expect(record.entries[0].message).toBeUndefined()
    const markup = typeof card.payload.reply_markup === 'string' ? JSON.parse(card.payload.reply_markup) : card.payload.reply_markup
    const data = markup.inline_keyboard.flat().find((b: any) => b.text === 'Yes').callback_data
    deliver(dir, [{ callback_query: { id: 'cb1', chat_instance: 'c', data, from: OWNER, message: { message_id: card.message_id, date: now(), chat: DM, reply_markup: markup } } }])
    await until(() => srv.inbound().some(n => n.meta.button === 'Yes'))
    await srv.close()
  }, 30000)

  test('the subagents message\'s first send answered 502 is not tried again until a write begun after it is answered, the probe\'s when the session writes nothing, and no event names it', async () => {
    const dir = state()
    const srv = await server(dir, { rules: [
      { method: 'sendMessage', has: '🤖 Subagents', times: 1, error: BAD_GATEWAY },
      { method: 'sendChatAction', error: BAD_GATEWAY },
    ] })
    deliver(dir, [{ message: { message_id: 600, date: now(), from: OWNER, chat: DM, text: 'hello' } }])
    await until(() => srv.inbound().length === 1)
    const base = join(dir, 'transcripts')
    mkdirSync(base)
    writeFileSync(join(base, 'agent-a1.meta.json'), JSON.stringify({ description: 'Long job' }))
    appendAgentEvent(agentEventFile(dir, srv.child.pid!), { t: Date.now(), event: 'start', agent_id: 'a1', agent_type: 'general-purpose', agent_base: join(base, 'agent-a1') })
    const panel = () => calls(dir).filter(c => c.method === 'sendMessage' && String(c.payload.text).startsWith('🤖 Subagents'))
    await until(() => panel().length === 1, AGENT_TICK_MS + 4000)
    await until(() => panel().length === 2, PROBE_MS + 15_000)
    // In the fake's log: the failed send, the probe a minute later, and only
    // then the next send, though the chat's slot came every 12 seconds.
    const all = calls(dir)
    const sent = all.flatMap((c, i) => c.method === 'sendMessage' && String(c.payload.text).startsWith('🤖 Subagents') ? [i] : [])
    const probe = all.findIndex((c, i) => i > sent[0]! && c.method === 'setMyCommands')
    expect(probe).toBeGreaterThan(sent[0]!)
    expect(sent[1]!).toBeGreaterThan(probe)
    expect(all[probe]!.at - all[sent[0]!]!.at).toBeGreaterThanOrEqual(PROBE_MS)
    expect(all[sent[1]!]!.refused).toBeUndefined()
    await wait(1000)
    expect(events(srv)).toEqual([])
    await srv.close()
  }, 30000)

  test('a server that does not poll the bot keeps today\'s result, opens no record and runs no probe', async () => {
    const dir = state()
    const srv = await server(dir, { argv: ['claude', '-p', 'hello'], rules: [{ method: 'sendMessage', error: BAD_GATEWAY }] })
    expect(text(await tool(srv, 'reply', { chat_id: '1', text: 'hello' }))).toBe(`${UNKNOWN} ${ANSWERED_502}`)
    await wait(PROBE_MS + 5000)
    expect(calls(dir).filter(c => c.method === 'setMyCommands')).toEqual([])
    expect(stallLines(dir, srv, 'opened')).toEqual([])
    await srv.close()
  }, 20000)
})
