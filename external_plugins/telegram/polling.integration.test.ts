import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn } from 'child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { asSeconds, calls, children, cleanup, CONFLICT, conflicts, deliver, driveClock, pollGaps, stamp, start, state, until, wait } from './fixtures/harness.ts'
import fixture from './fixtures/channel-argv.json'
import { AGENT_TICK_MS, appendAgentEvent, agentEventFile } from './agents.ts'
import { appendPermit, permitDetail, permitFile, permitText, type PermitEvent } from './permit.ts'
import { idleText, NO_OWNER, RECOVERED_TEXT, stuckText } from './alerts.ts'
import { NO_ASKS } from './asks.ts'
import { REFRESH_MS } from './typing.ts'
import { MAX_WAIT_MS } from './batch.ts'
import { API_CONSTANTS } from 'grammy'

beforeEach(driveClock)
afterEach(cleanup)

// Real /proc ancestry, real MCP transport, and the production server. Only
// grammy's HTTP transport is fake; these tests never use the owner's bot.
describe.skipIf(process.platform !== 'linux')('polling ownership in the running server', () => {
  test('the channel server tells the owner chat alone what the hook allowed, and See more shows the command', async () => {
    // The allowlist also holds another person and another bot.
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['5', '7491000', '1'] })
    const channel = start(dir, fixture.argv, { TELEGRAM_ALERT_CHAT: '1' })
    await channel.ready()
    const ev: PermitEvent = { t: Date.now(), event: 'allowed', tool_name: 'Bash', description: 'Push job archive to rental', command: 'ls -la /w', agent_type: 'general-purpose' }
    appendPermit(permitFile(dir, channel.child.pid!), ev)
    const notices = () => calls(dir).filter(c => c.method === 'sendMessage' && c.payload.text === permitText(ev))
    await until(() => notices().length > 0)
    await wait(1500)
    expect(notices()).toHaveLength(1)
    expect(notices()[0]!.payload.chat_id).toBe('1')
    expect(calls(dir).filter(c => c.method === 'sendMessage' && c.payload.chat_id !== '1')).toEqual([])
    // A notice pings, unlike the silent subagent stream.
    expect(notices()[0]!.payload.disable_notification).toBeUndefined()
    expect(notices()[0]!.payload.reply_markup).toEqual({ inline_keyboard: [[{ text: 'See more', callback_data: 'permit:p1' }]] })
    writeFileSync(join(dir, 'inbound.json'), JSON.stringify([{
      update_id: 1,
      callback_query: {
        id: 'cb1', chat_instance: 'c', data: 'permit:p1',
        from: { id: 1, is_bot: false, first_name: 'Owner' },
        message: { message_id: notices()[0]!.message_id, date: Math.floor(Date.now() / 1000), chat: { id: 1, type: 'private' }, text: permitText(ev),
          reply_markup: notices()[0]!.payload.reply_markup },
      },
    }]))
    await until(() => calls(dir).some(c => c.method === 'editMessageText' && c.payload.text === permitDetail(ev)))
    expect(channel.notifications.some(n => n.method === 'notifications/claude/channel/permission')).toBe(false)
    await channel.close()
  }, 15000)

  test('with no owner chat, the channel server tells no one what the hook allowed, and says so at start', async () => {
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1', '5'] })
    const channel = start(dir, fixture.argv, { TELEGRAM_ALERT_CHAT: '' })
    await channel.ready()
    await until(() => channel.stderr().includes('polling as @test_bot'))
    expect(channel.stderr()).toContain(`TELEGRAM_ALERT_CHAT is not set; ${NO_OWNER}`)
    appendPermit(permitFile(dir, channel.child.pid!), { t: Date.now(), event: 'allowed', tool_name: 'Bash', description: 'Push job archive to rental' })
    await wait(2500)
    expect(calls(dir).some(c => c.method === 'sendMessage')).toBe(false)
    await channel.close()
  }, 15000)

  test('a server that does not poll sends no notice for what the hook allowed', async () => {
    const dir = state()
    const sender = start(dir, ['claude', '-p', 'hello'])
    await sender.ready()
    appendPermit(permitFile(dir, sender.child.pid!), { t: Date.now(), event: 'allowed', tool_name: 'Bash', description: 'Push job archive to rental' })
    await wait(2500)
    expect(calls(dir).some(c => c.method === 'sendMessage')).toBe(false)
    await sender.close()
  }, 15000)

  test('the channel server shows four agents and their endings in one shared message', async () => {
    const dir = state()
    writeFileSync(join(dir, 'inbound.json'), JSON.stringify([{
      update_id: 1,
      message: { message_id: 1, date: Math.floor(Date.now() / 1000), text: 'stream test',
        from: { id: 1, is_bot: false, first_name: 'Owner' }, chat: { id: 1, type: 'private' } },
    }]))
    const channel = start(dir, fixture.argv)
    await channel.ready()
    const file = agentEventFile(dir, channel.child.pid!)
    const base = join(dir, 'transcripts')
    mkdirSync(base)
    for (let i = 1; i <= 4; i++) {
      const agentBase = join(base, `agent-a${i}`)
      writeFileSync(`${agentBase}.meta.json`, JSON.stringify({ description: `Shared agent ${i}` }))
      appendAgentEvent(file, { t: Date.now(), event: 'start', agent_id: `a${i}`, agent_type: 'general-purpose', agent_base: agentBase })
    }
    await until(() => calls(dir).some(c => c.method === 'sendMessage' && c.payload.text?.startsWith('🤖 Subagents')), AGENT_TICK_MS + 4000)
    const sent = calls(dir).filter(c => c.method === 'sendMessage' && c.payload.text?.startsWith('🤖 Subagents'))
    expect(sent).toHaveLength(1)
    for (let i = 1; i <= 4; i++) expect(sent[0]!.payload.text).toContain(`Shared agent ${i}`)
    expect(sent[0]!.payload.text.split('\n')).toHaveLength(5)
    appendAgentEvent(file, { t: Date.now(), event: 'stop', agent_id: 'a2', outcome: 'stopped' })
    appendAgentEvent(file, { t: Date.now(), event: 'stop', agent_id: 'a3' })
    await until(() => calls(dir).some(c => c.method === 'editMessageText' && c.payload.text?.includes('2. ⏹ Stopped after')
      && c.payload.text?.includes('3. ✅ Done in')), AGENT_TICK_MS + 4000)
    const edit = calls(dir).findLast(c => c.method === 'editMessageText')!
    expect(edit.payload.message_id).toBe(42)
    for (let i = 1; i <= 4; i++) expect(edit.payload.text).toContain(`Shared agent ${i}`)
    expect(calls(dir).filter(c => c.method === 'sendMessage' && c.payload.text?.startsWith('🤖 Subagents'))).toHaveLength(1)
    await channel.close()
  }, 15000)

  test('the channel server shows background shells beside an agent and each shell’s ending in the same message', async () => {
    const dir = state()
    writeFileSync(join(dir, 'inbound.json'), JSON.stringify([{
      update_id: 1,
      message: { message_id: 1, date: Math.floor(Date.now() / 1000), text: 'shell test',
        from: { id: 1, is_bot: false, first_name: 'Owner' }, chat: { id: 1, type: 'private' } },
    }]))
    const channel = start(dir, fixture.argv)
    await channel.ready()
    const file = agentEventFile(dir, channel.child.pid!)
    const tasks = join(dir, 'tasks')
    mkdirSync(tasks)
    const agentBase = join(tasks, 'agent-a1')
    writeFileSync(`${agentBase}.meta.json`, JSON.stringify({ description: 'Shared agent' }))
    appendAgentEvent(file, { t: Date.now(), event: 'start', agent_id: 'a1', agent_type: 'general-purpose', agent_base: agentBase })
    for (const [id, description] of [['b1', 'Passing shell'], ['b2', 'Failing shell'], ['b3', 'Stopped shell']]) {
      writeFileSync(join(tasks, `${id}.output`), '')
      appendAgentEvent(file, { t: Date.now(), event: 'shell_start', task_id: id!, description, output: join(tasks, `${id}.output`) })
    }
    const panel = (c: { method: string; payload: any }) => c.payload.text?.startsWith('🤖 Subagents · 🐚 Shells\n')
    await until(() => calls(dir).some(c => c.method === 'sendMessage' && panel(c)), AGENT_TICK_MS + 4000)
    const sent = calls(dir).find(c => c.method === 'sendMessage' && panel(c))!
    expect(sent.payload.text).toMatch(/^🤖 Subagents · 🐚 Shells\n1\. ⏳ general-purpose · Shared agent · Starting… · \d+s\n2\. ⏳ shell · Passing shell · \d+s\n3\. ⏳ shell · Failing shell · \d+s\n4\. ⏳ shell · Stopped shell · \d+s$/)
    appendFileSync(join(tasks, 'b1.output'), 'ok\n\n[exited with code 0]\n')
    appendFileSync(join(tasks, 'b2.output'), 'FAIL\n\n[exited with code 3]\n')
    appendAgentEvent(file, { t: Date.now(), event: 'shell_stop', task_id: 'b3', outcome: 'stopped' })
    await until(() => calls(dir).some(c => c.method === 'editMessageText' && panel(c) && c.payload.text.includes('2. ✅ Done in')
      && c.payload.text.includes('3. ❌ Failed after') && c.payload.text.includes('4. ⏹ Stopped after')), AGENT_TICK_MS + 4000)
    const edit = calls(dir).findLast(c => c.method === 'editMessageText')!
    expect(edit.payload.message_id).toBe(42)
    expect(edit.payload.text).toMatch(/\n1\. ⏳ general-purpose · Shared agent · /)
    expect(edit.payload.text).toMatch(/\n3\. ❌ Failed after \d+s \(exit 3\) · shell · Failing shell\n/)
    expect(calls(dir).filter(c => c.method === 'sendMessage' && panel(c))).toHaveLength(1)
    await channel.close()
  }, 15000)

  // A turn the server sees start and never end; the session's own marker ends it.
  test('a turn with no activity gets the stuck notice in its chat, and a turn end brings Claude back', async () => {
    const dir = state()
    writeFileSync(join(dir, 'inbound.json'), JSON.stringify([{
      update_id: 1,
      message: { message_id: 1, date: Math.floor(Date.now() / 1000), text: 'stuck test',
        from: { id: 1, is_bot: false, first_name: 'Owner' }, chat: { id: 1, type: 'private' } },
    }]))
    const channel = start(dir, fixture.argv, { TELEGRAM_STUCK_MINUTES: '0.01' })
    await channel.ready()
    const notices = () => calls(dir).filter(c => c.method === 'sendMessage' && c.payload.chat_id === '1')
    await until(() => notices().length > 0, 2 * REFRESH_MS + 4000)
    expect(notices()[0]!.payload.text).toBe(stuckText(600))
    expect(notices()[0]!.payload.disable_notification).toBeUndefined()
    mkdirSync(join(dir, 'turns'), { recursive: true })
    writeFileSync(join(dir, 'turns', `pid-${channel.child.pid}`), String(Date.now()))
    await until(() => notices().length > 1, 2 * REFRESH_MS + 4000)
    expect(notices().map(c => c.payload.text)).toEqual([stuckText(600), RECOVERED_TEXT])
    await channel.close()
  }, 25000)

  // The idle time is longer than one tick, so an alert that counted from no
  // activity at all would come on the first tick, before the time is up.
  test('the channel tells the alert chat when the session shows no activity, counting from its start, and when it is back', async () => {
    const dir = state()
    const begin = Date.now()
    const channel = start(dir, fixture.argv, { TELEGRAM_ALERT_CHAT: '77', TELEGRAM_ALERT_IDLE_MINUTES: '0.1' })
    await channel.ready()
    const alerts = () => calls(dir).filter(c => c.method === 'sendMessage' && c.payload.chat_id === '77')
    await until(() => alerts().length > 0, 6000 + 2 * REFRESH_MS + 4000)
    const idleAt = Date.now()
    expect(idleAt - begin).toBeGreaterThanOrEqual(6000)
    expect(alerts()[0]!.payload.text).toBe(idleText(6000))
    // The mark comes after the alert and carries the time on the test's
    // clock, as the busy hook's touch would at that moment.
    await wait(50)
    mkdirSync(join(dir, 'turns'), { recursive: true })
    writeFileSync(join(dir, 'turns', `busy-${channel.child.pid}`), '')
    stamp(join(dir, 'turns', `busy-${channel.child.pid}`))
    await until(() => alerts().length > 1, 2 * REFRESH_MS + 4000)
    expect(alerts().map(c => c.payload.text)).toEqual([idleText(6000), RECOVERED_TEXT])
    expect(calls(dir).filter(c => c.method === 'sendMessage' && c.payload.chat_id !== '77')).toEqual([])
    await channel.close()
  }, 35000)

  test('a send-only instance never sends the idle alert', async () => {
    const dir = state()
    const sender = start(dir, ['claude', 'mcp', 'list'], { TELEGRAM_ALERT_CHAT: '77', TELEGRAM_ALERT_IDLE_MINUTES: '0.01' })
    await sender.ready()
    await wait(600 + 2 * REFRESH_MS)
    expect(calls(dir)).toEqual([])
    expect(sender.child.exitCode).toBeNull()
    await sender.close()
  }, 20000)

  // Another bot on the allowlist, a person who is not the owner, and the owner.
  const BOT = { id: 7491000, is_bot: true, first_name: 'Peer', username: 'peer_7491_bot' }
  const PERSON = { id: 5, is_bot: false, first_name: 'Manager', username: 'manager' }
  const OWNER = { id: 1, is_bot: false, first_name: 'Owner', username: 'owner' }
  const PEERS = { dmPolicy: 'allowlist', allowFrom: ['1', String(BOT.id), '5'] }
  const dm = (from: { id: number }, message_id: number, text: string) =>
    ({ message: { message_id, date: Math.floor(Date.now() / 1000), from, chat: { id: from.id, type: 'private' }, text } })
  const updates = (...items: object[]) => JSON.stringify(items.map((u, i) => ({ update_id: i + 1, ...u })))
  const toBot = (c: { payload: any }) => c.payload.chat_id === String(BOT.id) || c.payload.chat_id === `@${BOT.username}`
  // Starts one subagent and returns the chat its live message went to.
  async function panelChat(dir: string, channel: ReturnType<typeof start>): Promise<string> {
    const base = join(dir, 'transcripts')
    mkdirSync(base, { recursive: true })
    writeFileSync(join(base, 'agent-a1.meta.json'), JSON.stringify({ description: 'Routed agent' }))
    appendAgentEvent(agentEventFile(dir, channel.child.pid!), { t: Date.now(), event: 'start', agent_id: 'a1', agent_type: 'general-purpose', agent_base: join(base, 'agent-a1') })
    const panel = (c: { method: string; payload: any }) => c.method === 'sendMessage' && c.payload.text?.startsWith('🤖 Subagents')
    await until(() => calls(dir).some(panel), AGENT_TICK_MS + 4000)
    return calls(dir).find(panel)!.payload.chat_id
  }

  test('after another bot writes, the subagent message goes to the owner chat and never to the bot', async () => {
    const dir = state(PEERS)
    writeFileSync(join(dir, 'inbound.json'), updates(dm(BOT, 1, 'from the other bot')))
    const channel = start(dir, fixture.argv, { TELEGRAM_ALERT_CHAT: '1' })
    await channel.ready()
    await until(() => channel.inbound().length === 1, 6000)
    expect(await panelChat(dir, channel)).toBe('1')
    expect(calls(dir).filter(c => c.method !== 'sendChatAction' && toBot(c))).toEqual([])
    await channel.close()
  }, 20000)

  test('when a person writes after the bot, the subagent message goes to that person', async () => {
    const dir = state(PEERS)
    writeFileSync(join(dir, 'inbound.json'), updates(dm(BOT, 1, 'from the other bot'), dm(PERSON, 2, 'from a person')))
    const channel = start(dir, fixture.argv, { TELEGRAM_ALERT_CHAT: '1' })
    await channel.ready()
    await until(() => channel.inbound().length === 2, 6000)
    expect(await panelChat(dir, channel)).toBe('5')
    await channel.close()
  }, 20000)

  test('after another bot edits a message, the subagent message goes to the owner chat', async () => {
    const dir = state(PEERS)
    const now = Math.floor(Date.now() / 1000)
    writeFileSync(join(dir, 'inbound.json'), updates({
      edited_message: { message_id: 7, date: now, edit_date: now + 5, from: BOT, chat: { id: BOT.id, type: 'private' }, text: 'edited by the other bot' },
    }))
    const channel = start(dir, fixture.argv, { TELEGRAM_ALERT_CHAT: '1' })
    await channel.ready()
    await until(() => channel.inbound().length === 1, 6000)
    expect(await panelChat(dir, channel)).toBe('1')
    await channel.close()
  }, 20000)

  test('a turn the owner and the bot both started gets one stuck notice and one back to normal, in the owner chat', async () => {
    const dir = state(PEERS)
    writeFileSync(join(dir, 'inbound.json'), updates(dm(OWNER, 1, 'from the owner'), dm(BOT, 2, 'from the other bot')))
    const channel = start(dir, fixture.argv, { TELEGRAM_ALERT_CHAT: '1', TELEGRAM_STUCK_MINUTES: '0.01' })
    await channel.ready()
    const notices = () => calls(dir).filter(c => c.method === 'sendMessage' && c.payload.chat_id === '1')
    await until(() => notices().length > 0, 2 * REFRESH_MS + 4000)
    mkdirSync(join(dir, 'turns'), { recursive: true })
    writeFileSync(join(dir, 'turns', `pid-${channel.child.pid}`), String(Date.now()))
    await until(() => notices().some(c => c.payload.text === RECOVERED_TEXT), 2 * REFRESH_MS + 4000)
    await wait(REFRESH_MS + 500)
    expect(notices().map(c => c.payload.text)).toEqual([stuckText(600), RECOVERED_TEXT])
    expect(calls(dir).filter(c => c.method === 'sendMessage' && c.payload.chat_id !== '1')).toEqual([])
    await channel.close()
  }, 25000)

  test('the reply tool sends to a bot by its @username, text and files alike, and to everyone else by id', async () => {
    const dir = state({ ...PEERS, allowFrom: [...PEERS.allowFrom, '7777', '6', '9'], groups: { '-100': { requireMention: true, allowFrom: [] } } })
    mkdirSync(join(dir, 'inbox'))
    writeFileSync(join(dir, 'inbox', 'chart.png'), 'png')
    writeFileSync(join(dir, 'inbox', 'notes.txt'), 'notes')
    writeFileSync(join(dir, 'inbound.json'), updates(dm(BOT, 1, 'from the other bot'), dm(PERSON, 2, 'from a person')))
    const channel = start(dir, fixture.argv, {
      TELEGRAM_ALERT_CHAT: '1',
      // An allowlisted bot and a person who have not written since the start,
      // and a chat Telegram will not describe.
      TELEGRAM_TEST_USERS: JSON.stringify({
        7777: { id: 7777, is_bot: true, first_name: 'Quiet', username: 'quiet_bot' },
        6: { id: 6, is_bot: false, first_name: 'Someone', username: 'someone' },
        9: null,
      }),
    })
    await channel.ready()
    await until(() => channel.inbound().length === 2, 6000)
    const reply = async (chat_id: string, text: string, files?: string[]) =>
      (await channel.request('tools/call', { name: 'reply', arguments: { chat_id, text, ...(files ? { files } : {}) } })).result
    const sendsOf = (text: string) => calls(dir).filter(c => c.payload.text === text || c.payload.caption === text)
    const sent = (text: string) => calls(dir).filter(c => c.method === 'sendMessage' && c.payload.text === text).map(c => c.payload.chat_id)

    expect((await reply(String(BOT.id), 'to the bot')).isError).not.toBe(true)
    expect(sent('to the bot')).toEqual([`@${BOT.username}`])
    const before = calls(dir).length
    expect((await reply(String(BOT.id), 'with files', [join(dir, 'inbox', 'chart.png'), join(dir, 'inbox', 'notes.txt')])).isError).not.toBe(true)
    // The files go first, as one album of documents carrying the text.
    expect(calls(dir).slice(before).filter(c => c.method.startsWith('send')).map(c => [c.method, c.payload.chat_id])).toEqual([
      ['sendMediaGroup', `@${BOT.username}`],
    ])
    await reply('5', 'to the person')
    expect(sent('to the person')).toEqual(['5'])
    await reply('7777', 'to the quiet bot')
    await reply('7777', 'to the quiet bot again')
    expect([...sent('to the quiet bot'), ...sent('to the quiet bot again')]).toEqual(['@quiet_bot', '@quiet_bot'])
    await reply('6', 'to someone')
    expect(sent('to someone')).toEqual(['6'])
    await reply('-100', 'to the group')
    expect(sent('to the group')).toEqual(['-100'])

    // The outbound gate reads the id Claude passed, so a username gets past nothing.
    const byName = await reply(`@${BOT.username}`, 'by name')
    expect(byName.isError).toBe(true)
    expect(byName.content[0].text).toContain('not allowlisted')
    // When Telegram will not say whether the chat is a bot's, nothing goes out.
    const unknown = await reply('9', 'to an undescribed chat')
    expect(unknown.isError).toBe(true)
    expect(unknown.content[0].text).toContain('could not tell whether chat 9 is a bot')
    expect(sendsOf('by name')).toEqual([])
    expect(sendsOf('to an undescribed chat')).toEqual([])

    // Telegram is asked only about the chats no message came from.
    expect(calls(dir).filter(c => c.method === 'getChatMember').map(c => [c.payload.chat_id, c.payload.user_id])).toEqual([
      ['7777', 7777], ['6', 6], ['9', 9],
    ])
    await channel.close()
  }, 20000)

  test('a session that does not poll sends a reply to an allowlisted bot that has not written by its @username, as plain text', async () => {
    const dir = state(PEERS)
    const sender = start(dir, ['claude', '-p', 'hello'], {
      TELEGRAM_RICH_MESSAGES: 'true',
      TELEGRAM_TEST_USERS: JSON.stringify({ [BOT.id]: BOT }),
    })
    await sender.ready()
    const sent = await sender.request('tools/call', { name: 'reply', arguments: { chat_id: String(BOT.id), text: '**rich** to the bot' } })
    expect(sent.result.isError).not.toBe(true)
    expect(calls(dir).map(c => [c.method, c.payload.chat_id])).toEqual([
      ['getChatMember', String(BOT.id)], ['sendMessage', `@${BOT.username}`],
    ])
    expect(calls(dir)[1]!.payload).toEqual({ chat_id: `@${BOT.username}`, text: '**rich** to the bot' })
    await sender.close()
  }, 15000)

  // The receiving plugin hands Claude a message's text, caption or media, and
  // a rich message carries none of them.
  test('with rich messages on, a reply or an edit to a bot goes as plain text, as written, whatever the format, and a person keeps rich', async () => {
    const dir = state(PEERS)
    const sender = start(dir, ['claude', '-p', 'hello'], {
      TELEGRAM_RICH_MESSAGES: 'true',
      TELEGRAM_TEST_USERS: JSON.stringify({ [BOT.id]: BOT, [PERSON.id]: PERSON }),
    })
    await sender.ready()
    const call = async (name: string, args: object) => {
      const r = (await sender.request('tools/call', { name, arguments: args })).result
      expect(r.isError).not.toBe(true)
    }
    const text = '**bold**, a_b. | x |'
    for (const format of [undefined, 'rich', 'markdownv2', 'text']) {
      await call('reply', { chat_id: String(BOT.id), text, ...(format ? { format } : {}) })
      await call('edit_message', { chat_id: String(BOT.id), message_id: '42', text, ...(format ? { format } : {}) })
    }
    const botCalls = calls(dir).filter(toBot)
    expect(botCalls.map(c => c.method)).toEqual([
      'getChatMember', ...Array(4).fill(['sendMessage', 'editMessageText']).flat(),
    ])
    for (const c of botCalls.slice(1)) {
      expect(c.payload.text).toBe(text)
      expect(c.payload.parse_mode).toBeUndefined()
      expect(c.payload.rich_message).toBeUndefined()
    }
    expect(botCalls.filter(c => c.method === 'sendMessage').map(c => c.payload.chat_id)).toEqual(Array(4).fill(`@${BOT.username}`))

    // A person's chat keeps the format asked for.
    await call('reply', { chat_id: '5', text })
    await call('edit_message', { chat_id: '5', message_id: '42', text })
    await call('reply', { chat_id: '5', text: '*bold*', format: 'markdownv2' })
    const toPerson = calls(dir).filter(c => c.payload.chat_id === '5' && c.method !== 'getChatMember')
    expect(toPerson.map(c => c.method)).toEqual(['sendRichMessage', 'editMessageText', 'sendMessage'])
    expect(toPerson[0]!.payload.rich_message).toBeDefined()
    expect(toPerson[1]!.payload.rich_message).toBeDefined()
    expect(toPerson[1]!.payload.text).toBeUndefined()
    expect(toPerson[2]!.payload.parse_mode).toBe('MarkdownV2')
    expect(calls(dir).filter(c => c.method === 'getChatMember').map(c => c.payload.chat_id)).toEqual([String(BOT.id), '5'])
    await sender.close()
  }, 15000)

  // A permission prompt from Claude Code, and a tap on one of its buttons,
  // which carries the keyboard its prompt, or a notice, was sent with.
  const ASK = { request_id: 'abcde', tool_name: 'Write', description: 'Write a file', input_preview: '{"file_path":"/w/a.txt"}' }
  const ASK_TEXT = '🔐 Permission: Write'
  const keyboardOf = (data: string) => data.startsWith('permit:')
    ? { inline_keyboard: [[{ text: 'See more', callback_data: data }]] }
    : { inline_keyboard: [[
        { text: 'See more', callback_data: data.replace(/^perm:\w+:/, 'perm:more:') },
        { text: '✅ Allow', callback_data: data.replace(/^perm:\w+:/, 'perm:allow:') },
        { text: '❌ Deny', callback_data: data.replace(/^perm:\w+:/, 'perm:deny:') },
      ]] }
  const bare = (id: string, from: { id: number }, data: string) => ({
    callback_query: {
      id, chat_instance: 'c', data, from,
      message: { message_id: 42, date: Math.floor(Date.now() / 1000), chat: { id: from.id, type: 'private' }, text: ASK_TEXT },
    },
  })
  const tap = (id: string, from: { id: number }, data: string) => {
    const update = bare(id, from, data)
    return { callback_query: { ...update.callback_query, message: { ...update.callback_query.message, reply_markup: keyboardOf(data) } } }
  }
  const answers = (channel: ReturnType<typeof start>) =>
    channel.notifications.filter(n => n.method === 'notifications/claude/channel/permission').map(n => n.params)
  const callbackAnswers = (dir: string) =>
    Object.fromEntries(calls(dir).filter(c => c.method === 'answerCallbackQuery').map(c => [c.payload.callback_query_id, c.payload.text ?? null]))

  test('a permission prompt goes to the owner chat alone, and only the owner’s tap or reply settles it', async () => {
    // The owner is last on the allowlist, after a person and another bot.
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['5', String(BOT.id), '1'] })
    const channel = start(dir, fixture.argv, { TELEGRAM_ALERT_CHAT: '1' })
    await channel.ready()
    await until(() => channel.stderr().includes('polling as @test_bot'))
    channel.notify('notifications/claude/channel/permission_request', ASK)
    const asks = () => calls(dir).filter(c => c.method === 'sendMessage' && c.payload.text === ASK_TEXT)
    await until(() => asks().length > 0)
    await wait(500)
    expect(asks().map(c => c.payload.chat_id)).toEqual(['1'])
    expect(asks()[0]!.payload.reply_markup).toEqual({ inline_keyboard: [[
      { text: 'See more', callback_data: 'perm:more:abcde' },
      { text: '✅ Allow', callback_data: 'perm:allow:abcde' },
      { text: '❌ Deny', callback_data: 'perm:deny:abcde' },
    ]] })

    // The person and the bot try every button and the reply; then the owner.
    writeFileSync(join(dir, 'inbound.json'), updates(
      tap('cb1', PERSON, 'perm:allow:abcde'),
      tap('cb2', BOT, 'perm:allow:abcde'),
      tap('cb3', PERSON, 'perm:more:abcde'),
      dm(PERSON, 11, 'yes abcde'),
      dm(BOT, 12, 'y abcde'),
      tap('cb4', OWNER, 'perm:more:abcde'),
      tap('cb5', OWNER, 'perm:deny:abcde'),
      dm(OWNER, 13, 'yes fghij'),
      dm(OWNER, 14, 'sentinel'),
    ))
    // Updates go in order, and a reply that answers is taken before batching,
    // so every answer is in by the time the last message reaches Claude.
    await until(() => channel.inbound().some(n => n.content === 'sentinel'), 6000)
    expect(answers(channel)).toEqual([{ request_id: 'abcde', behavior: 'deny' }, { request_id: 'fghij', behavior: 'allow' }])
    await until(() => channel.inbound().length === 3)
    expect(callbackAnswers(dir)).toEqual({ cb1: 'Not authorized.', cb2: 'Not authorized.', cb3: 'Not authorized.', cb4: null, cb5: '❌ Denied' })
    // See more and the outcome show in the owner chat alone.
    expect(calls(dir).filter(c => c.method === 'editMessageText').map(c => [String(c.payload.chat_id), c.payload.text])).toEqual([
      ['1', `${ASK_TEXT}\n\ntool_name: Write\ndescription: Write a file\ninput_preview:\n{\n  "file_path": "/w/a.txt"\n}`],
      ['1', `${ASK_TEXT}\n\n❌ Denied`],
    ])
    expect(calls(dir).filter(c => c.method === 'setMessageReaction').map(c => [String(c.payload.chat_id), c.payload.message_id])).toEqual([['1', 13]])
    // The others' replies reach Claude as ordinary messages.
    expect(channel.inbound().map(n => [n.meta.user_id, n.content]).sort()).toEqual([
      ['1', 'sentinel'], ['5', 'yes abcde'], [String(BOT.id), 'y abcde'],
    ])
    expect(calls(dir).filter(c => c.method === 'sendMessage' && c.payload.chat_id !== '1')).toEqual([])
    await channel.close()
  }, 20000)

  test.each([
    ['not set', '', `TELEGRAM_ALERT_CHAT is not set; ${NO_OWNER}`],
    ['a group', '-1001234', `TELEGRAM_ALERT_CHAT=-1001234 is a group, not the owner's private chat; ${NO_ASKS}`],
  ])('with the owner chat %s, a permission prompt reaches no one on Telegram, no tap or reply settles it, and the server says so at start', async (_, chat, warning) => {
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1', '5'] })
    const channel = start(dir, fixture.argv, { TELEGRAM_ALERT_CHAT: chat })
    await channel.ready()
    await until(() => channel.stderr().includes('polling as @test_bot'))
    expect(channel.stderr()).toContain(warning)
    channel.notify('notifications/claude/channel/permission_request', ASK)
    await wait(500)
    writeFileSync(join(dir, 'inbound.json'), updates(
      tap('cb1', OWNER, 'perm:allow:abcde'),
      tap('cb2', PERSON, 'perm:more:abcde'),
      dm(OWNER, 11, 'yes abcde'),
      dm(PERSON, 12, 'sentinel'),
    ))
    await until(() => channel.inbound().some(n => n.content === 'sentinel'), 6000)
    expect(answers(channel)).toEqual([])
    await until(() => channel.inbound().length === 2)
    expect(callbackAnswers(dir)).toEqual({ cb1: 'Not authorized.', cb2: 'Not authorized.' })
    expect(calls(dir).filter(c => ['sendMessage', 'editMessageText', 'setMessageReaction'].includes(c.method))).toEqual([])
    expect(channel.inbound().map(n => [n.meta.user_id, n.content]).sort()).toEqual([['1', 'yes abcde'], ['5', 'sentinel']])
    await channel.close()
  }, 20000)

  test('an edit of a text, a photo caption and a document caption reaches Claude as its own event', async () => {
    const dir = state()
    const now = Math.floor(Date.now() / 1000)
    const owner = { id: 1, is_bot: false, first_name: 'Owner', username: 'owner' }
    const chat = { id: 1, type: 'private' }
    const photo = [{ file_id: 'p1', file_unique_id: 'pu1', width: 1, height: 1 }]
    const document = { file_id: 'd1', file_unique_id: 'du1', file_name: 'plan.pdf' }
    const sent = (message_id: number, extra: object) => ({ message: { message_id, date: now, from: owner, chat, ...extra } })
    const edit = (message_id: number, extra: object) => ({ edited_message: { message_id, date: now, edit_date: now + 5, from: owner, chat, ...extra } })
    writeFileSync(join(dir, 'inbound.json'), JSON.stringify([
      sent(10, { text: 'deploy to staging' }),
      edit(10, { text: 'deploy to prod' }),
      sent(11, { photo, caption: 'the left one' }),
      edit(11, { photo, caption: 'the right one' }),
      sent(12, { document, caption: 'page 3' }),
      edit(12, { document, caption: 'page 4' }),
      // Telegram also sends edits that leave the text as it was, and edits
      // that are no one correcting text, such as a live location moving.
      edit(10, { text: 'deploy to prod', entities: [{ type: 'bold', offset: 0, length: 6 }] }),
      edit(13, { location: { latitude: 41.7, longitude: 44.8, live_period: 900 } }),
      sent(16, { text: 'as it was' }),
      edit(16, { text: 'as it was', entities: [{ type: 'italic', offset: 0, length: 2 }] }),
      // An edit never answers a permission prompt.
      edit(14, { text: 'yes abcde' }),
      sent(15, { text: 'sentinel' }),
    ].map((u, i) => ({ update_id: i + 1, ...u }))))
    const channel = start(dir, fixture.argv)
    await channel.ready()
    await until(() => channel.inbound().some(n => n.content === 'sentinel'), 6000)
    const ts = new Date((now + 5) * 1000).toISOString()
    const base = { chat_id: '1', edited: 'true', user: 'owner', user_id: '1', ts }
    expect(channel.inbound()).toEqual([
      { content: 'deploy to staging', meta: { chat_id: '1', message_id: '10', user: 'owner', user_id: '1', ts: new Date(now * 1000).toISOString() } },
      { content: 'deploy to prod', meta: { ...base, message_id: '10' } },
      expect.objectContaining({ content: 'the left one' }),
      { content: 'the right one', meta: { ...base, message_id: '11', attachment_kind: 'photo' } },
      expect.objectContaining({ content: 'page 3' }),
      { content: 'page 4', meta: { ...base, message_id: '12', attachment_kind: 'document' } },
      expect.objectContaining({ content: 'as it was' }),
      { content: 'yes abcde', meta: { ...base, message_id: '14' } },
      expect.objectContaining({ content: 'sentinel' }),
    ])
    expect(channel.notifications.some(n => n.method === 'notifications/claude/channel/permission')).toBe(false)
    expect(calls(dir).some(c => c.method === 'sendMessage')).toBe(false)
    await channel.close()
  }, 15000)

  test('an edit from a sender a new message could not come from reaches nothing, and pairs and writes nothing', async () => {
    // Pairing mode, read live, with an expired pending code: a pairing reply,
    // or the prune a new message runs, would show.
    const access = {
      dmPolicy: 'pairing', allowFrom: ['1'], pending: { abc123: { senderId: '3', chatId: '3', createdAt: 0, expiresAt: 1, replies: 1 } },
      groups: { '-100': { requireMention: true, allowFrom: [] } },
    }
    const dir = state(access)
    const before = readFileSync(join(dir, 'access.json'), 'utf8')
    const mtime = statSync(join(dir, 'access.json')).mtimeMs
    const now = Math.floor(Date.now() / 1000)
    const stranger = { id: 2, is_bot: false, first_name: 'Stranger' }
    const member = { id: 5, is_bot: false, first_name: 'Member', username: 'member' }
    const group = (id: number) => ({ id, type: 'supergroup', title: 'g' })
    const edit = (message_id: number, from: object, chat: object, extra: object) =>
      ({ edited_message: { message_id, date: now, edit_date: now + 5, from, chat, ...extra } })
    const mention = (text: string) => ({ text, entities: [{ type: 'mention', offset: 0, length: 9 }] })
    writeFileSync(join(dir, 'inbound.json'), JSON.stringify([
      edit(20, stranger, { id: 2, type: 'private' }, { text: 'let me in' }),
      edit(21, stranger, { id: 2, type: 'private' }, { photo: [{ file_id: 'p', file_unique_id: 'u', width: 1, height: 1 }], caption: 'let me in' }),
      edit(22, member, group(-100), { text: 'no mention here' }),
      edit(23, member, group(-200), mention('@test_bot in a group with no policy')),
      edit(24, member, group(-100), mention('@test_bot check this')),
      edit(25, { id: 1, is_bot: false, first_name: 'Owner', username: 'owner' }, { id: 1, type: 'private' }, { text: 'sentinel' }),
    ].map((u, i) => ({ update_id: i + 1, ...u }))))
    const channel = start(dir, fixture.argv, { TELEGRAM_ACCESS_MODE: '' })
    await channel.ready()
    await until(() => channel.inbound().some(n => n.content === 'sentinel'), 6000)
    expect(channel.inbound().map(n => [n.meta.chat_id, n.meta.message_id, n.content])).toEqual([
      ['-100', '24', '@test_bot check this'],
      ['1', '25', 'sentinel'],
    ])
    expect(calls(dir).some(c => c.method === 'sendMessage')).toBe(false)
    expect(readFileSync(join(dir, 'access.json'), 'utf8')).toBe(before)
    expect(statSync(join(dir, 'access.json')).mtimeMs).toBe(mtime)
    await channel.close()
  }, 15000)

  test('a stranger’s new message still gets a pairing code, and their edit of it gets nothing more', async () => {
    const dir = state({ dmPolicy: 'pairing', allowFrom: ['1'], groups: {}, pending: {} })
    const now = Math.floor(Date.now() / 1000)
    const stranger = { id: 2, is_bot: false, first_name: 'Stranger' }
    writeFileSync(join(dir, 'inbound.json'), JSON.stringify([
      { update_id: 1, message: { message_id: 30, date: now, from: stranger, chat: { id: 2, type: 'private' }, text: 'hi' } },
      { update_id: 2, edited_message: { message_id: 30, date: now, edit_date: now + 5, from: stranger, chat: { id: 2, type: 'private' }, text: 'hi there' } },
      { update_id: 3, edited_message: { message_id: 31, date: now, edit_date: now + 5, from: { id: 1, is_bot: false, first_name: 'Owner' }, chat: { id: 1, type: 'private' }, text: 'sentinel' } },
    ]))
    const channel = start(dir, fixture.argv, { TELEGRAM_ACCESS_MODE: '' })
    await channel.ready()
    await until(() => channel.inbound().some(n => n.content === 'sentinel'), 6000)
    expect(channel.inbound().map(n => n.content)).toEqual(['sentinel'])
    const replies = calls(dir).filter(c => c.method === 'sendMessage')
    expect(replies).toHaveLength(1)
    expect(replies[0]!.payload.chat_id).toBe(2)
    expect(replies[0]!.payload.text).toStartWith('Pairing required')
    const pending = Object.values(JSON.parse(readFileSync(join(dir, 'access.json'), 'utf8')).pending) as { senderId: string; replies: number }[]
    expect(pending).toMatchObject([{ senderId: '2', replies: 1 }])
    await channel.close()
  }, 15000)

  test('in a group, an edit goes after the text another member sent before it', async () => {
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1'], groups: { '-100': { requireMention: false, allowFrom: [] } } })
    const now = Math.floor(Date.now() / 1000)
    const chat = { id: -100, type: 'supergroup', title: 'g' }
    writeFileSync(join(dir, 'inbound.json'), JSON.stringify([
      { update_id: 1, message: { message_id: 40, date: now, from: { id: 6, is_bot: false, first_name: 'A' }, chat, text: 'first' } },
      { update_id: 2, edited_message: { message_id: 39, date: now, edit_date: now + 5, from: { id: 5, is_bot: false, first_name: 'B' }, chat, text: 'second, edited' } },
    ]))
    const channel = start(dir, fixture.argv)
    await channel.ready()
    await until(() => channel.inbound().length === 2, 6000)
    expect(channel.inbound().map(n => [n.meta.user_id, n.content])).toEqual([['6', 'first'], ['5', 'second, edited']])
    await channel.close()
  }, 15000)

  // A sender's reaction on a message, from what it was to what it is now: a
  // string is a standard emoji, anything else a reaction of another type.
  const REACTED_AT = Math.floor(Date.now() / 1000)
  const DM = { id: 1, type: 'private' }
  const react = (from: { id: number }, chat: object, message_id: number, before: (string | object)[], after: (string | object)[]) => {
    const types = (list: (string | object)[]) => list.map(r => typeof r === 'string' ? { type: 'emoji', emoji: r } : r)
    return { message_reaction: { chat, message_id, user: from, date: REACTED_AT, old_reaction: types(before), new_reaction: types(after) } }
  }
  const reactedMeta = (message_id: number, reaction: string) =>
    ({ chat_id: '1', message_id: String(message_id), reaction, user: 'owner', user_id: '1', ts: new Date(REACTED_AT * 1000).toISOString() })
  // Starts the channel server, has Claude send text to the owner with the
  // reply tool, and returns the server and the id Telegram gave the message.
  async function botSent(dir: string, text: string, env: Record<string, string> = {}) {
    const channel = start(dir, fixture.argv, env)
    await channel.ready()
    const result = (await channel.request('tools/call', { name: 'reply', arguments: { chat_id: '1', text } })).result
    expect(result.isError).not.toBe(true)
    return { channel, id: Number(/^sent \(id: (\d+)\)$/.exec(result.content[0].text)![1]) }
  }
  // Waits for the first event, then long enough for any other to show.
  async function settled(channel: ReturnType<typeof start>) {
    await until(() => channel.inbound().length > 0, 6000)
    await wait(500)
    return channel.inbound()
  }

  test('the channel server asks Telegram for its own list: the twenty kinds it got before and reactions, none of the kinds grammY added later', async () => {
    const dir = state()
    const channel = start(dir, fixture.argv)
    await channel.ready()
    await until(() => calls(dir).some(c => c.method === 'getUpdates'))
    const asked = calls(dir).find(c => c.method === 'getUpdates')!.payload.allowed_updates
    expect(asked).toEqual([
      'message', 'edited_message', 'channel_post', 'edited_channel_post', 'business_connection', 'business_message',
      'edited_business_message', 'deleted_business_messages', 'inline_query', 'chosen_inline_result', 'callback_query',
      'shipping_query', 'pre_checkout_query', 'purchased_paid_media', 'poll', 'poll_answer', 'my_chat_member',
      'chat_join_request', 'chat_boost', 'removed_chat_boost', 'message_reaction',
    ])
    for (const added of ['guest_message', 'stopped_message_generation', 'managed_bot', 'subscription']) {
      expect(API_CONSTANTS.DEFAULT_UPDATE_TYPES).toContain(added)
      expect(asked).not.toContain(added)
    }
    await channel.close()
  }, 15000)

  test('an allowed sender’s emoji on a message the bot sent reaches Claude at once as one reaction event, with the message’s opening words', async () => {
    const dir = state()
    const { channel, id } = await botSent(dir, 'Deploy finished.\n\nAll checks pass on the branch. Merge?')
    writeFileSync(join(dir, 'inbound.json'), updates(react(OWNER, DM, id, [], ['👍'])))
    expect(await settled(channel)).toEqual([
      { content: `👍 on message ${id}: "Deploy finished. All checks pass on the branch. Merge?"`, meta: reactedMeta(id, '👍') },
    ])
    // The reply is the only message sent: a reaction gets no answer of its own.
    expect(calls(dir).filter(c => c.method === 'sendMessage')).toHaveLength(1)
    await channel.close()
  }, 15000)

  test('a stranger’s reaction reaches nothing, and pairs, answers and writes nothing', async () => {
    // Pairing mode, read live, with an expired pending code: a pairing reply,
    // or the prune a new message runs, would show.
    const dir = state({
      dmPolicy: 'pairing', allowFrom: ['1'], groups: {},
      pending: { abc123: { senderId: '3', chatId: '3', createdAt: 0, expiresAt: 1, replies: 1 } },
    })
    const before = readFileSync(join(dir, 'access.json'), 'utf8')
    const mtime = statSync(join(dir, 'access.json')).mtimeMs
    const { channel, id } = await botSent(dir, 'Merge now?', { TELEGRAM_ACCESS_MODE: '' })
    writeFileSync(join(dir, 'inbound.json'), updates(
      react({ id: 2, is_bot: false, first_name: 'Stranger' }, { id: 2, type: 'private' }, id, [], ['👍']),
      // The owner's reaction comes after the stranger's.
      react(OWNER, DM, id, [], ['🔥']),
    ))
    expect((await settled(channel)).map(n => [n.meta.user_id, n.meta.reaction])).toEqual([['1', '🔥']])
    expect(calls(dir).filter(c => c.method === 'sendMessage').map(c => c.payload.chat_id)).toEqual(['1'])
    expect(readFileSync(join(dir, 'access.json'), 'utf8')).toBe(before)
    expect(statSync(join(dir, 'access.json')).mtimeMs).toBe(mtime)
    await channel.close()
  }, 15000)

  test('a reaction on a message the sender sent reaches nothing', async () => {
    const dir = state()
    const channel = start(dir, fixture.argv)
    await channel.ready()
    writeFileSync(join(dir, 'inbound.json'), updates(
      dm(OWNER, 10, 'ship it'),
      react(OWNER, DM, 10, [], ['👍']),
      react(OWNER, DM, 11, [], ['🔥']),
    ))
    await until(() => channel.inbound().length === 2, 6000)
    await wait(500)
    expect(channel.inbound().map(n => [n.meta.message_id, n.meta.reaction ?? n.content])).toEqual([['10', 'ship it'], ['11', '🔥']])
    await channel.close()
  }, 15000)

  test('a switch from one emoji to another delivers the new one', async () => {
    const dir = state()
    const { channel, id } = await botSent(dir, 'Merge now?')
    writeFileSync(join(dir, 'inbound.json'), updates(react(OWNER, DM, id, ['👍'], ['👎'])))
    expect(await settled(channel)).toEqual([{ content: `👎 on message ${id}: "Merge now?"`, meta: reactedMeta(id, '👎') }])
    await channel.close()
  }, 15000)

  test('a second emoji beside the first delivers the second alone', async () => {
    const dir = state()
    const { channel, id } = await botSent(dir, 'Merge now?')
    writeFileSync(join(dir, 'inbound.json'), updates(react(OWNER, DM, id, ['👍'], ['👍', '❤'])))
    expect(await settled(channel)).toEqual([{ content: `❤ on message ${id}: "Merge now?"`, meta: reactedMeta(id, '❤') }])
    await channel.close()
  }, 15000)

  test('a bare removal delivers nothing', async () => {
    const dir = state()
    const { channel, id } = await botSent(dir, 'Merge now?')
    writeFileSync(join(dir, 'inbound.json'), updates(
      react(OWNER, DM, id, ['👍'], []),
      react(OWNER, DM, id, [], ['🔥']),
    ))
    expect((await settled(channel)).map(n => n.meta.reaction)).toEqual(['🔥'])
    await channel.close()
  }, 15000)

  test('custom-emoji and paid reactions deliver nothing', async () => {
    const dir = state()
    const { channel, id } = await botSent(dir, 'Merge now?')
    const custom = { type: 'custom_emoji', custom_emoji_id: 'custom-1' }
    writeFileSync(join(dir, 'inbound.json'), updates(
      react(OWNER, DM, id, [], [custom]),
      react(OWNER, DM, id, [custom], [{ type: 'paid' }]),
      react(OWNER, DM, id, ['👍'], ['👍', custom]),
      react(OWNER, DM, id, [], ['🔥']),
    ))
    expect((await settled(channel)).map(n => n.meta.reaction)).toEqual(['🔥'])
    await channel.close()
  }, 15000)

  test('a reaction on a message neither memory holds, such as one sent before the server started, goes by its number alone', async () => {
    const dir = state()
    const channel = start(dir, fixture.argv)
    await channel.ready()
    writeFileSync(join(dir, 'inbound.json'), updates(react(OWNER, DM, 77, [], ['👍'])))
    expect(await settled(channel)).toEqual([{ content: '👍 on message 77', meta: reactedMeta(77, '👍') }])
    await channel.close()
  }, 15000)

  test('a reaction in a group reaches nothing, even from a member the group admits without a mention', async () => {
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1'], groups: { '-100': { requireMention: false, allowFrom: [] } } })
    const channel = start(dir, fixture.argv)
    await channel.ready()
    writeFileSync(join(dir, 'inbound.json'), updates(
      react(OWNER, { id: -100, type: 'supergroup', title: 'g' }, 5, [], ['👍']),
      react(OWNER, DM, 6, [], ['🔥']),
    ))
    expect((await settled(channel)).map(n => [n.meta.chat_id, n.meta.reaction])).toEqual([['1', '🔥']])
    await channel.close()
  }, 15000)

  test('after edit_message, a reaction on the message quotes its new text', async () => {
    const dir = state()
    const { channel, id } = await botSent(dir, 'working…')
    const edited = (await channel.request('tools/call', { name: 'edit_message', arguments: { chat_id: '1', message_id: String(id), text: 'Done: all checks pass' } })).result
    expect(edited.isError).not.toBe(true)
    writeFileSync(join(dir, 'inbound.json'), updates(react(OWNER, DM, id, [], ['👍'])))
    expect((await settled(channel)).map(n => n.content)).toEqual([`👍 on message ${id}: "Done: all checks pass"`])
    await channel.close()
  }, 15000)

  test('with rich messages on, a reaction on a rich reply quotes what Claude wrote', async () => {
    const dir = state()
    const { channel, id } = await botSent(dir, '**Deploy** finished', { TELEGRAM_RICH_MESSAGES: 'true' })
    expect(calls(dir).some(c => c.method === 'sendRichMessage')).toBe(true)
    writeFileSync(join(dir, 'inbound.json'), updates(react(OWNER, DM, id, [], ['👍'])))
    expect((await settled(channel)).map(n => n.content)).toEqual([`👍 on message ${id}: "**Deploy** finished"`])
    await channel.close()
  }, 15000)

  test('a reaction on a file the bot sent names the file', async () => {
    const dir = state()
    mkdirSync(join(dir, 'inbox'))
    writeFileSync(join(dir, 'inbox', 'chart.png'), 'png')
    const channel = start(dir, fixture.argv)
    await channel.ready()
    const result = (await channel.request('tools/call', { name: 'reply', arguments: { chat_id: '1', text: 'the chart', files: [join(dir, 'inbox', 'chart.png')] } })).result
    expect(result.isError).not.toBe(true)
    const photo = calls(dir).find(c => c.method === 'sendPhoto')
    expect(photo).toBeDefined()
    // The offline Telegram gives every message the same id, so the photo's
    // words replace the text's.
    const id = Number(/^sent 2 parts \(ids: (\d+), \1\)$/.exec(result.content[0].text)![1])
    writeFileSync(join(dir, 'inbound.json'), updates(react(OWNER, DM, id, [], ['👍'])))
    expect((await settled(channel)).map(n => n.content)).toEqual([`👍 on message ${id}: "(photo: chart.png)"`])
    await channel.close()
  }, 15000)

  test.each([
    ['claude', '-p', 'hello'],
    ['claude', 'mcp', 'list'],
    ['claude', '--continue'],
  ])('a non-channel session sends without polling or touching a live holder: %j', async (...argv) => {
    const dir = state()
    const channel = start(dir, fixture.argv)
    await channel.ready()
    await until(() => calls(dir).some(call => call.method === 'getUpdates') && existsSync(join(dir, 'poll-heartbeat.json')))
    const holder = readFileSync(join(dir, 'bot.pid'), 'utf8')
    const before = statSync(join(dir, 'bot.pid')).mtimeMs
    const sentBefore = calls(dir).length
    const sender = start(dir, argv)
    await sender.ready()
    const tools = await sender.request('tools/list', {})
    expect(tools.result.tools.some((tool: { name: string }) => tool.name === 'reply')).toBe(true)
    const sent = await sender.request('tools/call', { name: 'reply', arguments: { chat_id: '1', text: 'offline test' } })
    expect(sent.result.isError).not.toBe(true)
    const send = calls(dir).slice(sentBefore).find(call => call.method === 'sendMessage')!
    expect(send).toBeDefined()
    // Whether chat 1 is a bot's, then the message; nothing that polls.
    expect(calls(dir).filter(call => call.pid === send.pid).map(call => call.method)).toEqual(['getChatMember', 'sendMessage'])
    await sender.close()
    expect(readFileSync(join(dir, 'bot.pid'), 'utf8')).toBe(holder)
    expect(statSync(join(dir, 'bot.pid')).mtimeMs).toBe(before)
    expect(JSON.parse(readFileSync(join(dir, 'poll-heartbeat.json'), 'utf8')).pid).toBe(Number(holder))
    expect(channel.child.exitCode).toBeNull()
    expect(sender.stderr()).toContain('send-only')
    await channel.close()
    expect(existsSync(join(dir, 'bot.pid'))).toBe(false)
  })

  test('with two runs of three conflicts and a completed poll between them, the server waits 1, 2 and 3 seconds in each run', async () => {
    const dir = state()
    const channel = start(dir, fixture.argv, conflicts([
      { method: 'getUpdates', times: 3, error: CONFLICT },
      { method: 'getUpdates', skip: 1, times: 3, error: CONFLICT },
    ]))
    await channel.ready()
    await until(() => pollGaps(dir).length >= 7, 35_000)
    const [a, b, c, , d, e, f] = pollGaps(dir)
    expect(asSeconds([a!, b!, c!, d!, e!, f!], [1, 2, 3, 1, 2, 3], 400)).toEqual([1, 2, 3, 1, 2, 3])
    await channel.close()
  }, 45_000)

  test('a server whose MCP input closes during the wait after a conflict polls no more', async () => {
    const dir = state()
    const channel = start(dir, fixture.argv, conflicts([{ method: 'getUpdates', times: 1, error: CONFLICT }]))
    await channel.ready()
    await until(() => calls(dir).some(c => c.method === 'getUpdates' && c.refused))
    const closed = Date.now()
    channel.child.stdin!.end()
    await until(() => channel.child.exitCode !== null, 5000)
    expect(calls(dir).filter(c => c.method === 'getUpdates' && c.at > closed)).toEqual([])
  }, 20_000)

  test('a server that gets SIGTERM during the wait after a conflict polls no more', async () => {
    const dir = state()
    const channel = start(dir, fixture.argv, conflicts([{ method: 'getUpdates', times: 1, error: CONFLICT }]))
    await channel.ready()
    await until(() => calls(dir).some(c => c.method === 'getUpdates' && c.refused))
    const pid = Number(readFileSync(join(dir, 'bot.pid'), 'utf8'))
    const termed = Date.now()
    process.kill(pid, 'SIGTERM')
    await until(() => !existsSync(`/proc/${pid}`), 5000)
    expect(calls(dir).filter(c => c.method === 'getUpdates' && c.at > termed)).toEqual([])
  }, 20_000)

  test('a send-only instance creates neither bot.pid nor a heartbeat', async () => {
    const dir = state()
    const sender = start(dir, ['claude', 'mcp', 'list'])
    await sender.ready()
    await sender.close()
    expect(calls(dir)).toEqual([])
    expect(existsSync(join(dir, 'bot.pid'))).toBe(false)
    expect(existsSync(join(dir, 'poll-heartbeat.json'))).toBe(false)
  })

  test('the newest channel replaces the previous channel and keeps its pid on shutdown', async () => {
    const dir = state()
    const first = start(dir, fixture.argv)
    await first.ready()
    await until(() => calls(dir).some(call => call.method === 'getUpdates'))
    const previous = readFileSync(join(dir, 'bot.pid'), 'utf8')
    const second = start(dir, fixture.argv)
    await second.ready()
    await until(() => first.child.exitCode !== null)
    await until(() => existsSync(join(dir, 'poll-heartbeat.json')) &&
      JSON.parse(readFileSync(join(dir, 'poll-heartbeat.json'), 'utf8')).pid === Number(readFileSync(join(dir, 'bot.pid'), 'utf8')))
    expect(readFileSync(join(dir, 'bot.pid'), 'utf8')).not.toBe(previous)
    expect(second.stderr()).toContain(`replacing stale poller pid=${previous}`)
    expect(second.child.exitCode).toBeNull()
    await second.close()
    expect(existsSync(join(dir, 'bot.pid'))).toBe(false)
  })

  test('a channel replaces an orphan holder, but leaves an unrelated recycled pid alive', async () => {
    const dir = state()
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'server.ts'])
    children.push(orphan)
    writeFileSync(join(dir, 'bot.pid'), String(orphan.pid))
    const channel = start(dir, fixture.argv)
    await channel.ready()
    await until(() => orphan.signalCode === 'SIGTERM')
    expect(channel.stderr()).toContain(`replacing stale poller pid=${orphan.pid}`)
    await channel.close()

    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
    children.push(unrelated)
    writeFileSync(join(dir, 'bot.pid'), String(unrelated.pid))
    const restarted = start(dir, fixture.argv)
    await restarted.ready()
    await until(() => calls(dir).some(call => call.pid === Number(readFileSync(join(dir, 'bot.pid'), 'utf8')) && call.method === 'getUpdates'))
    expect(unrelated.signalCode).toBeNull()
    expect(restarted.stderr()).not.toContain('replacing stale poller')
    await restarted.close()
    unrelated.kill('SIGTERM')
    await until(() => unrelated.signalCode === 'SIGTERM')
  })

  // Bots the owner added with /telegram:access bot <id> @username, made up
  // for these tests. Telegram's own text fields carry the fixture's marker.
  const MARK = 'text-telegram-returned'
  const at = (username: string) => `@${username}`
  const peerBot = (id: number, username: string) => ({ id, is_bot: true, first_name: 'Peer', username })
  const toolCall = async (proc: ReturnType<typeof start>, name: string, args: object) =>
    (await proc.request('tools/call', { name, arguments: args })).result
  // The text of a failed tool call, which never carries a field Telegram returned.
  const failure = (result: any): string => {
    expect(result.isError).toBe(true)
    expect(result.content[0].text).not.toContain(MARK)
    return result.content[0].text
  }
  const SENDS = ['sendMessage', 'sendPhoto', 'sendDocument', 'sendRichMessage', 'sendMediaGroup']
  const sends = (dir: string) => calls(dir).filter(c => SENDS.includes(c.method))
  const command = (from: { id: number }, message_id: number, name: string) => ({ message: {
    message_id, date: Math.floor(Date.now() / 1000), from, chat: { id: from.id, type: 'private' }, text: `/${name}`,
    entities: [{ type: 'bot_command', offset: 0, length: name.length + 1 }],
  } })

  test('the first reply to an allowlisted bot that never wrote opens its chat by the stored username, and goes plain to the username Telegram gives', async () => {
    const FRESH = peerBot(7002, 'Fresh_PeerBot')
    const EDITED = peerBot(7003, 'edited_peer_bot')
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1', '7002', '7003'], botUsernames: { '7002': 'Fresh_PeerBot', '7003': 'edited_peer_bot' } })
    const sender = start(dir, ['claude', '-p', 'hello'], {
      TELEGRAM_RICH_MESSAGES: 'true',
      TELEGRAM_TEST_USERS: JSON.stringify({ 7002: FRESH, 7003: EDITED }),
      TELEGRAM_TEST_CHATS: JSON.stringify({ unopened: [7002, 7003] }),
    })
    await sender.ready()
    expect((await toolCall(sender, 'reply', { chat_id: '7002', text: '**first** contact' })).isError).not.toBe(true)
    // getChatMember by id fails, the stored username opens the chat, and
    // getChatMember then describes the bot.
    expect(calls(dir).map(c => [c.method, c.payload.chat_id])).toEqual([
      ['getChatMember', '7002'], ['getChat', at(FRESH.username)], ['getChatMember', '7002'], ['sendMessage', at(FRESH.username)],
    ])
    expect(calls(dir)[3]!.payload).toEqual({ chat_id: at(FRESH.username), text: '**first** contact' })
    await until(() => sender.stderr().includes(`opened chat 7002 by ${at('Fresh_PeerBot')}`))
    // Kept: the next reply makes no call but its own.
    const before = calls(dir).length
    expect((await toolCall(sender, 'reply', { chat_id: '7002', text: 'again' })).isError).not.toBe(true)
    expect(calls(dir).slice(before).map(c => [c.method, c.payload.chat_id])).toEqual([['sendMessage', at(FRESH.username)]])

    // edit_message's bot check takes the same way, and edits by numeric id, plain.
    const edit = calls(dir).length
    expect((await toolCall(sender, 'edit_message', { chat_id: '7003', message_id: '42', text: '**done**' })).isError).not.toBe(true)
    expect(calls(dir).slice(edit).map(c => [c.method, c.payload.chat_id])).toEqual([
      ['getChatMember', '7003'], ['getChat', at(EDITED.username)], ['getChatMember', '7003'], ['editMessageText', '7003'],
    ])
    expect(calls(dir).at(-1)!.payload).toEqual({ chat_id: '7003', message_id: 42, text: '**done**' })
    await sender.close()
  }, 15000)

  test('a stored username that does not lead to the allowlisted bot, or an entry the server ignores, sends nothing, and each error names ids, not what Telegram returned', async () => {
    const users = {
      7031: peerBot(7031, 'thirty_one_bot'),
      // Holds the username stored for 7031.
      7039: peerBot(7039, 'taken_name_bot'),
      7032: peerBot(7032, 'thirty_two_bot'),
      7033: peerBot(7033, 'thirty_three_bot'),
      7034: { id: 7034, is_bot: false, first_name: 'Person', username: 'thirty_four_bot' },
      7035: peerBot(7035, 'thirty_five_bot'),
      7036: peerBot(7036, 'thirty_six_bot'),
      7037: peerBot(7037, 'thirty_seven_bot'),
      7038: peerBot(7038, 'thirty_eight_bot'),
      7041: peerBot(7041, 'forty_one_bot'),
    }
    const dir = state({
      dmPolicy: 'allowlist',
      allowFrom: ['1', '7031', '7032', '7033', '7034', '7035', '7036', '7037', '7041'],
      // 7038 is only a groups key: the fallback runs only for allowFrom.
      groups: { '7038': { requireMention: true, allowFrom: [] } },
      botUsernames: {
        '7031': 'taken_name_bot', '7032': 'nobody_holds_bot', '7033': 'thirty_three_bot', '7034': 'thirty_four_bot',
        '7035': 'thirty_five_bat', '7036': { name: 'thirty_six_bot' }, '7037': 'thirty_seven_bot', '7038': 'thirty_eight_bot',
      },
    })
    const sender = start(dir, ['claude', '-p', 'hello'], {
      TELEGRAM_TEST_USERS: JSON.stringify(users),
      TELEGRAM_TEST_CHATS: JSON.stringify({ unopened: [7031, 7032, 7034, 7035, 7036, 7038, 7041], closed: [7033], flood: { 7037: 7 } }),
    })
    await sender.ready()
    const errors: Record<string, string> = {}
    for (const id of ['7031', '7032', '7033', '7034', '7035', '7036', '7037', '7038', '7041']) {
      errors[id] = failure(await toolCall(sender, 'reply', { chat_id: id, text: `to ${id}` }))
    }
    expect(errors).toEqual({
      7031: `reply failed: ${at('taken_name_bot')} is chat 7039, not 7031`,
      7032: `reply failed: could not open chat 7032 by ${at('nobody_holds_bot')}: getChat failed (400: Bad Request: chat not found)`,
      7033: `reply failed: chat 7033 opened by ${at('thirty_three_bot')}, but getChatMember failed (400: Bad Request: chat not found)`,
      7034: `reply failed: chat 7034 is not a bot, so nothing goes to ${at('thirty_four_bot')}`,
      7035: 'reply failed: botUsernames entry for 7035 is not a bot username',
      7036: 'reply failed: botUsernames entry for 7036 is not a bot username',
      7037: "reply failed: could not tell whether chat 7037 is a bot: Call to 'getChatMember' failed! (429: Too Many Requests: retry after 7)",
      7038: "reply failed: could not tell whether chat 7038 is a bot: Call to 'getChatMember' failed! (400: Bad Request: chat not found)",
      7041: "reply failed: could not tell whether chat 7041 is a bot: Call to 'getChatMember' failed! (400: Bad Request: chat not found)",
    })
    expect(sends(dir)).toEqual([])
    // getChat only for the entries that pass the filter, after a refusal that was no flood control.
    expect(calls(dir).filter(c => c.method === 'getChat').map(c => c.payload.chat_id)).toEqual(
      ['taken_name_bot', 'nobody_holds_bot', 'thirty_three_bot', 'thirty_four_bot'].map(at),
    )
    // The chat counts as opened only once getChat returned the allowlisted id.
    const opened = sender.stderr().split('\n').filter(line => line.includes('opened chat')).map(line => line.replace(/^.*opened chat /, ''))
    expect(opened).toEqual([`7033 by ${at('thirty_three_bot')}`, `7034 by ${at('thirty_four_bot')}`])
    await sender.close()
  }, 15000)

  test.each([
    ['returns the bot', {}, undefined],
    ['returns another id', { redirect: { username: 'given_four_bot', to: 9997 } }, 'the username Telegram gives for 7004 is chat 9997, not 7004'],
    ['is refused', { refuse: ['given_four_bot'] }, 'could not check the username Telegram gives for 7004: getChat failed (400: Bad Request: chat not found)'],
  ])('when getChatMember gives a username other than the stored one and getChat by it %s, the reply goes to it only once that id is the bot’s', async (_, chats, error) => {
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1', '7004'], botUsernames: { '7004': 'stored_four_bot' } })
    const sender = start(dir, ['claude', '-p', 'hello'], {
      TELEGRAM_TEST_USERS: JSON.stringify({ 7004: peerBot(7004, 'given_four_bot') }),
      TELEGRAM_TEST_CHATS: JSON.stringify({ unopened: [7004], second: { 7004: 'stored_four_bot' }, ...chats }),
    })
    await sender.ready()
    const result = await toolCall(sender, 'reply', { chat_id: '7004', text: 'hello other name' })
    const checks = [['getChatMember', '7004'], ['getChat', at('stored_four_bot')], ['getChatMember', '7004'], ['getChat', at('given_four_bot')]]
    if (error === undefined) {
      expect(result.isError).not.toBe(true)
      expect(calls(dir).map(c => [c.method, c.payload.chat_id])).toEqual([...checks, ['sendMessage', at('given_four_bot')]])
    } else {
      const text = failure(result)
      expect(text).toBe(`reply failed: ${error}`)
      expect(text.toLowerCase()).not.toContain('given_four_bot')
      expect(calls(dir).map(c => [c.method, c.payload.chat_id])).toEqual(checks)
    }
    await sender.close()
  }, 15000)

  // The reply below goes as an album of two documents, then its text in two
  // pieces, textChunkLimit aside; the album's messages count as sent together.
  test.each([
    ['the album', 1, 'reply failed after 2 of 4 message(s) sent (ids: 500, 501): message 500 went to chat 9999, not 7010'],
    ['the first text piece', 2, 'reply failed after 3 of 4 message(s) sent (ids: 500, 501, 502): message 502 went to chat 9999, not 7010'],
    ['a later text piece', 3, 'reply failed after 4 of 4 message(s) sent (ids: 500, 501, 502, 503): message 503 went to chat 9999, not 7010'],
  ])('when %s of a reply to a bot went to another chat, nothing more goes, the bot keeps its notices away from its chat, and its username is checked before the next reply', async (_, from, line) => {
    const PEER10 = peerBot(7010, 'peer_ten_bot')
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1', '7010'], textChunkLimit: 10 })
    mkdirSync(join(dir, 'inbox'))
    writeFileSync(join(dir, 'inbox', 'chart.png'), 'png')
    writeFileSync(join(dir, 'inbox', 'notes.txt'), 'notes')
    writeFileSync(join(dir, 'inbound.json'), updates(dm(PEER10, 1, 'from the peer bot')))
    const channel = start(dir, fixture.argv, {
      TELEGRAM_ALERT_CHAT: '1',
      // Long enough that the stuck notice comes after the reply below.
      TELEGRAM_STUCK_MINUTES: '0.1',
      TELEGRAM_TEST_CHATS: JSON.stringify({ redirect: { username: PEER10.username, to: 9999, from, ids: 500 } }),
    })
    await channel.ready()
    await until(() => channel.inbound().length === 1, 6000)
    const toPeer = () => sends(dir).filter(c => String(c.payload.chat_id).toLowerCase() === at(PEER10.username))

    const result = await toolCall(channel, 'reply', { chat_id: '7010', text: 'a'.repeat(4096) + 'b'.repeat(904), files: [join(dir, 'inbox', 'chart.png'), join(dir, 'inbox', 'notes.txt')] })
    expect(failure(result)).toBe(`reply failed: ${line}`)
    expect(channel.stderr()).toContain(line)
    expect(toPeer().map(c => c.method)).toEqual(['sendMediaGroup', 'sendMessage', 'sendMessage'].slice(0, from))

    // An edit goes by numeric id, plain, with no lookup.
    const before = calls(dir).length
    expect((await toolCall(channel, 'edit_message', { chat_id: '7010', message_id: '42', text: '*x*', format: 'markdownv2' })).isError).not.toBe(true)
    expect(calls(dir).slice(before).filter(c => c.method !== 'sendChatAction' && c.method !== 'getUpdates').map(c => [c.method, c.payload])).toEqual([
      ['editMessageText', { chat_id: '7010', message_id: 42, text: '*x*' }],
    ])

    // The next reply asks Telegram again, and the username still answers another chat.
    const again = calls(dir).length
    const next = failure(await toolCall(channel, 'reply', { chat_id: '7010', text: 'again' }))
    expect(next).toBe('reply failed: the username Telegram gives for 7010 is chat 9999, not 7010')
    expect(calls(dir).slice(again).filter(c => c.method !== 'sendChatAction' && c.method !== 'getUpdates').map(c => [c.method, c.payload.chat_id])).toEqual([
      ['getChatMember', '7010'], ['getChat', at(PEER10.username)],
    ])

    // Still a bot's chat: the subagent message and the stuck notice go to the owner chat.
    expect(await panelChat(dir, channel)).toBe('1')
    const stuck = (c: { method: string; payload: any }) => c.method === 'sendMessage' && c.payload.text === stuckText(6000)
    await until(() => calls(dir).some(stuck), 2 * REFRESH_MS + 4000)
    expect(calls(dir).filter(stuck).map(c => c.payload.chat_id)).toEqual(['1'])
    expect(calls(dir).findIndex(stuck)).toBeGreaterThan(calls(dir).findLastIndex(c => SENDS.includes(c.method) && c.payload.chat_id === at(PEER10.username)))
    expect(toPeer()).toHaveLength(from)
    expect(sends(dir).filter(c => c.payload.chat_id === '7010')).toEqual([])
    await channel.close()
  }, 25000)

  test('a reply whose next message starts after another reply’s message went elsewhere checks the username first, and sends nothing while it answers another chat', async () => {
    const PEER20 = peerBot(7020, 'peer_twenty_bot')
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1', '7020'], textChunkLimit: 10 })
    const sender = start(dir, ['claude', '-p', 'hello'], {
      TELEGRAM_TEST_USERS: JSON.stringify({ 7020: PEER20 }),
      // The first send waits, so the second reply's send answers first.
      TELEGRAM_TEST_CHATS: JSON.stringify({ redirect: { username: PEER20.username, to: 9998, from: 2, ids: 600 }, hold: { send: 1, ms: 1500 } }),
    })
    await sender.ready()
    const first = toolCall(sender, 'reply', { chat_id: '7020', text: 'a'.repeat(10) + 'b'.repeat(10) })
    await until(() => sends(dir).length === 1)
    const second = failure(await toolCall(sender, 'reply', { chat_id: '7020', text: 'second' }))
    expect(second).toBe('reply failed: reply failed after 1 of 1 message(s) sent (ids: 601): message 601 went to chat 9998, not 7020')
    expect(failure(await first)).toBe('reply failed: reply failed after 1 of 2 chunk(s) sent (ids: 600): the username Telegram gives for 7020 is chat 9998, not 7020')
    expect(calls(dir).map(c => [c.method, c.payload.chat_id ?? c.payload.text])).toEqual([
      ['getChatMember', '7020'], ['sendMessage', at(PEER20.username)], ['sendMessage', at(PEER20.username)],
      ['getChatMember', '7020'], ['getChat', at(PEER20.username)],
    ])
    expect(sends(dir).map(c => c.payload.text)).toEqual(['a'.repeat(10), 'second'])
    await sender.close()
  }, 15000)

  test('people, groups and bots that already wrote make no getChat call', async () => {
    const PEER70 = peerBot(7070, 'seventy_peer_bot')
    const dir = state({
      dmPolicy: 'allowlist', allowFrom: ['1', '7070', '5', '6'], groups: { '-100': { requireMention: true, allowFrom: [] } },
      botUsernames: { '7070': 'seventy_peer_bot', '5': 'five_peer_bot', '6': 'six_peer_bot' },
    })
    mkdirSync(join(dir, 'inbox'))
    writeFileSync(join(dir, 'inbox', 'notes.txt'), 'notes')
    writeFileSync(join(dir, 'inbound.json'), updates(dm(PEER70, 1, 'from the peer bot'), dm(PERSON, 2, 'from a person')))
    const channel = start(dir, fixture.argv, { TELEGRAM_ALERT_CHAT: '1' })
    await channel.ready()
    await until(() => channel.inbound().length === 2, 6000)
    for (const [chat_id, files] of [['7070', [join(dir, 'inbox', 'notes.txt')]], ['7070', []], ['5', []], ['6', []], ['-100', []], ['1', []]] as [string, string[]][]) {
      expect((await toolCall(channel, 'reply', { chat_id, text: `to ${chat_id}`, files })).isError).not.toBe(true)
    }
    // The bot's file goes first, the text as its caption.
    expect(sends(dir).map(c => [c.method, c.payload.chat_id])).toEqual([
      ['sendDocument', at(PEER70.username)], ['sendMessage', at(PEER70.username)],
      ['sendMessage', '5'], ['sendMessage', '6'], ['sendMessage', '-100'], ['sendMessage', '1'],
    ])
    expect(sends(dir)[0]!.payload.caption).toBe('to 7070')
    expect(calls(dir).filter(c => c.method === 'getChat')).toEqual([])
    expect(calls(dir).filter(c => c.method === 'getChatMember').map(c => c.payload.chat_id)).toEqual(['6', '1'])
    await channel.close()
  }, 15000)

  // A reply with files to another bot goes files first, every file as a
  // document, ten to an album and a single file left over by itself, and its
  // text as the first file's caption, or after the files.
  async function toPeerBot(access: object = {}, env: Record<string, string> = {}) {
    const PEER = peerBot(7080, 'peer_eighty_bot')
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1', '7080'], ...access })
    mkdirSync(join(dir, 'inbox'))
    const sender = start(dir, ['claude', '-p', 'hello'], { TELEGRAM_TEST_USERS: JSON.stringify({ 7080: PEER }), ...env })
    await sender.ready()
    const file = (name: string) => { const path = join(dir, 'inbox', name); writeFileSync(path, name); return path }
    const reply = (args: object) => toolCall(sender, 'reply', { chat_id: '7080', ...args })
    return { dir, sender, file, reply, to: at(PEER.username) }
  }
  // What an album carries: each message's kind, file and caption.
  const mediaOf = (c: { payload: any }) => c.payload.media.map((m: any) => [m.type, m.media, m.caption])
  // An upload carries reply_parameters as JSON text.
  const threadOf = (c: { payload: any }) => typeof c.payload.reply_parameters === 'string' ? JSON.parse(c.payload.reply_parameters) : c.payload.reply_parameters
  // What the reply tool returns for the messages the fake logged.
  const sentAs = (logged: { message_id?: number; message_ids?: number[] }[]) => {
    const ids = logged.flatMap(c => c.message_ids ?? [c.message_id!])
    return ids.length === 1 ? `sent (id: ${ids[0]})` : `sent ${ids.length} parts (ids: ${ids.join(', ')})`
  }

  test('to a bot, one file and a short text go as one document captioned with the text, threaded, and no text message follows', async () => {
    const t = await toPeerBot()
    const result = await t.reply({ text: 'the report', files: [t.file('report.pdf')], reply_to: '9' })
    expect(result.isError).not.toBe(true)
    expect(result.content[0].text).toBe(sentAs(sends(t.dir)))
    expect(sends(t.dir).map(c => [c.method, c.payload.chat_id, c.payload.document, c.payload.caption, threadOf(c)])).toEqual([
      ['sendDocument', t.to, 'file:report.pdf', 'the report', { message_id: 9 }],
    ])
    await t.sender.close()
  }, 15000)

  test('to a bot, a photo goes as a document, and a text empty once trimmed sends no text message, while an empty text alone is still refused', async () => {
    const t = await toPeerBot()
    for (const text of ['', ' \n ']) {
      const from = sends(t.dir).length
      expect((await t.reply({ text, files: [t.file('chart.png')] })).isError).not.toBe(true)
      expect(sends(t.dir).slice(from).map(c => [c.method, c.payload.document, c.payload.caption])).toEqual([['sendDocument', 'file:chart.png', undefined]])
    }
    expect(failure(await t.reply({ text: '' }))).toContain('message text is empty')
    expect(calls(t.dir).filter(c => c.method === 'sendPhoto')).toEqual([])
    await t.sender.close()
  }, 15000)

  test('to a bot, three files, a photo among them, go as one threaded album of documents with the text as the first one\'s caption', async () => {
    const t = await toPeerBot()
    const result = await t.reply({ text: 'three files', files: [t.file('chart.png'), t.file('notes.txt'), t.file('data.csv')], reply_to: '9' })
    expect(result.content[0].text).toBe(sentAs(sends(t.dir)))
    expect(sends(t.dir)[0]!.message_ids).toHaveLength(3)
    expect(sends(t.dir).map(c => [c.method, c.payload.chat_id, mediaOf(c), threadOf(c)])).toEqual([
      ['sendMediaGroup', t.to, [['document', 'file:chart.png', 'three files'], ['document', 'file:notes.txt', undefined], ['document', 'file:data.csv', undefined]], { message_id: 9 }],
    ])
    await t.sender.close()
  }, 15000)

  test('to a bot, eleven files go as an album of ten and one document, and twelve as albums of ten and two, in order', async () => {
    const t = await toPeerBot()
    const names = Array.from({ length: 12 }, (_, i) => `f${i + 1}.txt`)
    const files = names.map(t.file)
    const result = await t.reply({ text: 'eleven', files: files.slice(0, 11) })
    const eleven = sends(t.dir)
    expect(result.content[0].text).toBe(sentAs(eleven))
    expect(result.content[0].text).toStartWith('sent 11 parts')
    expect(eleven.map(c => c.method)).toEqual(['sendMediaGroup', 'sendDocument'])
    expect(mediaOf(eleven[0]!)).toEqual(names.slice(0, 10).map((n, i) => ['document', `file:${n}`, i === 0 ? 'eleven' : undefined]))
    expect([eleven[1]!.payload.document, eleven[1]!.payload.caption]).toEqual(['file:f11.txt', undefined])
    expect((await t.reply({ text: 'twelve', files })).isError).not.toBe(true)
    const twelve = sends(t.dir).slice(2)
    expect(twelve.map(c => c.method)).toEqual(['sendMediaGroup', 'sendMediaGroup'])
    expect(twelve.flatMap(mediaOf)).toEqual(names.map((n, i) => ['document', `file:${n}`, i === 0 ? 'twelve' : undefined]))
    await t.sender.close()
  }, 15000)

  test('to a bot, a long text follows the files in pieces of 4096 characters whatever chunkMode and textChunkLimit say, every line break kept, threaded as text chunks are', async () => {
    const t = await toPeerBot({ chunkMode: 'newline', textChunkLimit: 1000 })
    const text = 'a'.repeat(2000) + '\n\n' + 'b'.repeat(1500) + '\n' + 'c'.repeat(1497)
    const result = await t.reply({ text, files: [t.file('a.txt'), t.file('b.txt')], reply_to: '9' })
    const sent = sends(t.dir)
    expect(result.content[0].text).toBe(sentAs(sent))
    expect(result.content[0].text).toStartWith('sent 4 parts')
    expect(sent.map(c => c.method)).toEqual(['sendMediaGroup', 'sendMessage', 'sendMessage'])
    expect(mediaOf(sent[0]!)).toEqual([['document', 'file:a.txt', undefined], ['document', 'file:b.txt', undefined]])
    expect(sent.slice(1).map(c => c.payload.text.length)).toEqual([4096, 904])
    expect(sent.slice(1).map(c => c.payload.text).join('')).toBe(text)
    expect(sent.map(threadOf)).toEqual([{ message_id: 9 }, { message_id: 9 }, undefined])
    await t.sender.close()
  }, 15000)

  test('to a bot, a refused album fails the reply with nothing sent, and a text piece refused after an album counts every album message as sent', async () => {
    const WRONG = { error_code: 400, description: 'Bad Request: wrong file identifier' }
    const TOO_LONG = { error_code: 400, description: 'Bad Request: message is too long' }
    const t = await toPeerBot({}, { TELEGRAM_TEST_RULES: JSON.stringify([{ method: 'sendMediaGroup', times: 1, error: WRONG }, { method: 'sendMessage', times: 1, error: TOO_LONG }]) })
    const args = { text: 'x'.repeat(5000), files: [t.file('a.txt'), t.file('b.txt')] }
    expect(failure(await t.reply(args))).toBe('reply failed: part 1 of 3 (an album of 2 documents): not sent (Telegram answered 400: Bad Request: wrong file identifier); sent so far: none; never tried: parts 2 to 3')
    const second = failure(await t.reply(args))
    const album = sends(t.dir)[1]!.message_ids!
    expect(second).toBe(`reply failed: part 2 of 3: not sent (Telegram answered 400: Bad Request: message is too long); sent so far: 2 message(s) (ids: ${album.join(', ')}); never tried: part 3`)
    expect(sends(t.dir).map(c => [c.method, c.refused])).toEqual([
      ['sendMediaGroup', WRONG.description], ['sendMediaGroup', undefined], ['sendMessage', TOO_LONG.description],
    ])
    await t.sender.close()
  }, 15000)

  test('a photo whose download failed reaches Claude with its file reference, in one message with the text sent after it', async () => {
    const dir = state(PEERS)
    const now = Math.floor(Date.now() / 1000)
    const photo = [{ file_id: 'small', file_unique_id: 'su', width: 1, height: 1 }, { file_id: 'p1', file_unique_id: 'pu1', width: 2, height: 2, file_size: 512 }]
    // The offline Telegram's getFile gives no file path, so no download.
    writeFileSync(join(dir, 'inbound.json'), updates(
      { message: { message_id: 50, date: now, from: PERSON, chat: { id: PERSON.id, type: 'private' }, photo, caption: 'look' } },
      dm(PERSON, 51, 'what is it?'),
    ))
    const channel = start(dir, fixture.argv)
    await channel.ready()
    await until(() => channel.inbound().length > 0, 6000)
    await wait(MAX_WAIT_MS)
    expect(channel.inbound()).toEqual([{ content: 'look\nwhat is it?', meta: expect.objectContaining({
      message_ids: '50,51', attachment_kind: 'photo', attachment_file_id: 'p1', attachment_size: '512',
    }) }])
    expect(channel.inbound()[0]!.meta.image_path).toBeUndefined()
    await channel.close()
  }, 20000)

  // What reaches Claude from a document, other than its joining a burst,
  // stays as it was.
  test('a document sent alone reaches Claude with the meta it always had, and the same person\'s text a second later reaches it as a message of its own', async () => {
    const dir = state(PEERS)
    const channel = start(dir, fixture.argv)
    await channel.ready()
    await until(() => channel.stderr().includes('polling as '))
    const now = Math.floor(Date.now() / 1000)
    const document = { file_id: 'd1', file_unique_id: 'du1', file_name: 'plan.pdf', mime_type: 'application/pdf', file_size: 2048 }
    deliver(dir, [{ message: { message_id: 20, date: now, from: PERSON, chat: { id: PERSON.id, type: 'private' }, document } }])
    await wait(1000)
    deliver(dir, [dm(PERSON, 21, 'and one more thing')])
    await until(() => channel.inbound().length === 2, 6000)
    await wait(MAX_WAIT_MS)
    expect(channel.inbound()).toEqual([
      { content: '(document: plan.pdf)', meta: {
        chat_id: '5', message_id: '20', user: 'manager', user_id: '5', ts: new Date(now * 1000).toISOString(),
        attachment_kind: 'document', attachment_file_id: 'd1', attachment_size: '2048', attachment_mime: 'application/pdf', attachment_name: 'plan.pdf',
      } },
      { content: 'and one more thing', meta: expect.objectContaining({ message_id: '21', user_id: '5' }) },
    ])
    await channel.close()
  }, 20000)

  test('in a group, a member\'s text then another member\'s document, and that document then the first member\'s text, reach Claude in the order sent', async () => {
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1'], groups: { '-100': { requireMention: false, allowFrom: [] } } })
    const now = Math.floor(Date.now() / 1000)
    const chat = { id: -100, type: 'supergroup', title: 'g' }
    const P = { id: 6, is_bot: false, first_name: 'P' }
    const Q = { id: 7, is_bot: false, first_name: 'Q' }
    // A piece of a long paste waits longest for what follows it.
    const paste = 'p'.repeat(4096)
    writeFileSync(join(dir, 'inbound.json'), updates(
      { message: { message_id: 60, date: now, from: P, chat, text: paste } },
      { message: { message_id: 61, date: now, from: Q, chat, document: { file_id: 'q1', file_unique_id: 'qu1', file_name: 'q.pdf' } } },
      { message: { message_id: 62, date: now, from: P, chat, text: 'after the document' } },
    ))
    const channel = start(dir, fixture.argv)
    await channel.ready()
    await until(() => channel.inbound().length === 3, 6000)
    await wait(MAX_WAIT_MS)
    expect(channel.inbound().map(n => [n.meta.user_id, n.content])).toEqual([['6', paste], ['7', '(document: q.pdf)'], ['6', 'after the document']])
    await channel.close()
  }, 20000)

  test('the owner\'s document, then a permission answer, reach Claude in that order', async () => {
    const dir = state(PEERS)
    const now = Math.floor(Date.now() / 1000)
    writeFileSync(join(dir, 'inbound.json'), updates(
      { message: { message_id: 30, date: now, from: OWNER, chat: { id: OWNER.id, type: 'private' }, document: { file_id: 'd3', file_unique_id: 'du3', file_name: 'log.txt' } } },
      dm(OWNER, 31, 'yes abcde'),
    ))
    const channel = start(dir, fixture.argv, { TELEGRAM_ALERT_CHAT: '1' })
    await channel.ready()
    await until(() => answers(channel).length === 1, 6000)
    await wait(1000)
    const events = channel.notifications.filter(n => n.method.startsWith('notifications/claude/channel'))
    expect(events.map(n => n.method === 'notifications/claude/channel/permission' ? n.params : n.params.content)).toEqual([
      '(document: log.txt)', { request_id: 'abcde', behavior: 'allow' },
    ])
    await channel.close()
  }, 20000)

  test('a chat id that is not numeric is refused before any call, constructor included, and a numeric one not allowlisted says only the owner allowlists it', async () => {
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1'], groups: { '-100': { requireMention: true, allowFrom: [] } }, botUsernames: { '7050': 'fifty_peer_bot' } })
    const sender = start(dir, ['claude', '-p', 'hello'], { TELEGRAM_TEST_USERS: JSON.stringify({ 7050: peerBot(7050, 'fifty_peer_bot') }) })
    await sender.ready()
    const args = (chat_id: string) => ({ reply: { chat_id, text: 'x' }, react: { chat_id, message_id: '42', emoji: '👍' }, edit_message: { chat_id, message_id: '42', text: 'x' } })
    for (const id of [at('fifty_peer_bot'), 'fifty_peer_bot', 'constructor', 'toString', '__proto__', 'hasOwnProperty', '0', '01', '-0100', '1.0', '']) {
      for (const [name, a] of Object.entries(args(id))) {
        expect(failure(await toolCall(sender, name, a))).toBe(
          `${name} failed: chat ${id} is not allowlisted: chat ids are numeric, and only the owner adds another bot, in the terminal, with /telegram:access bot <id> @username`)
      }
    }
    for (const [name, a] of Object.entries(args('7050'))) {
      expect(failure(await toolCall(sender, name, a))).toBe(`${name} failed: chat 7050 is not allowlisted: only the owner allowlists a chat, in the terminal, with /telegram:access`)
    }
    expect(calls(dir)).toEqual([])
    await sender.close()
  }, 15000)

  test('a groups array allowlists no chat, so a reply makes no call and sends nothing', async () => {
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['5'], groups: [{ requireMention: true }, { requireMention: true }], botUsernames: { '1': 'one_peer_bot' } })
    const sender = start(dir, ['claude', '-p', 'hello'], {
      TELEGRAM_TEST_USERS: JSON.stringify({ 1: peerBot(1, 'one_peer_bot') }),
      TELEGRAM_TEST_CHATS: JSON.stringify({ unopened: [1] }),
    })
    await sender.ready()
    expect(failure(await toolCall(sender, 'reply', { chat_id: '1', text: 'x' }))).toBe(
      'reply failed: chat 1 is not allowlisted: only the owner allowlists a chat, in the terminal, with /telegram:access')
    expect(calls(dir)).toEqual([])
    await sender.close()
  }, 15000)

  test('an allowFrom that is a string admits no id it contains: not outbound, not the bot lookup, not the inbound gate or /start, and no button tap', async () => {
    const SUB = { id: 23, is_bot: false, first_name: 'Sub', username: 'sub' }
    const dir = state({
      dmPolicy: 'allowlist', allowFrom: '1234',
      // 23 passes the outbound check only as a groups key, so the bot lookup's own check shows.
      groups: { '23': { requireMention: true, allowFrom: [] } },
      botUsernames: { '23': 'twenty_three_bot', '34': 'thirty_four_bot' },
    })
    const channel = start(dir, fixture.argv, {
      TELEGRAM_ALERT_CHAT: '23',
      TELEGRAM_TEST_USERS: JSON.stringify({ 23: peerBot(23, 'twenty_three_bot') }),
      TELEGRAM_TEST_CHATS: JSON.stringify({ unopened: [23] }),
    })
    await channel.ready()
    await until(() => channel.stderr().includes('polling as'))
    expect(failure(await toolCall(channel, 'react', { chat_id: '34', message_id: '42', emoji: '👍' }))).toBe(
      'react failed: chat 34 is not allowlisted: only the owner allowlists a chat, in the terminal, with /telegram:access')
    expect(failure(await toolCall(channel, 'reply', { chat_id: '234', text: 'x' }))).toContain('chat 234 is not allowlisted')
    expect(failure(await toolCall(channel, 'reply', { chat_id: '23', text: 'x' }))).toBe(
      "reply failed: could not tell whether chat 23 is a bot: Call to 'getChatMember' failed! (400: Bad Request: chat not found)")
    writeFileSync(join(dir, 'inbound.json'), updates(
      dm(SUB, 11, 'let me in'),
      dm({ ...SUB, id: 34 }, 12, 'me too'),
      command({ ...SUB, id: 34 }, 13, 'start'),
      tap('cb1', SUB, 'perm:allow:abcde'),
      tap('cb2', SUB, 'permit:p1'),
    ))
    await until(() => calls(dir).filter(c => c.method === 'answerCallbackQuery').length === 2, 6000)
    await wait(500)
    expect(callbackAnswers(dir)).toEqual({ cb1: 'Not authorized.', cb2: 'Not authorized.' })
    expect(channel.inbound()).toEqual([])
    expect(answers(channel)).toEqual([])
    expect(calls(dir).filter(c => c.method === 'getChat' || SENDS.includes(c.method) || c.method === 'editMessageText')).toEqual([])
    await channel.close()
  }, 20000)

  test('with an allowFrom that is a string, /status answers no one as paired', async () => {
    const dir = state({ dmPolicy: 'pairing', allowFrom: '1234', groups: {}, pending: {} })
    writeFileSync(join(dir, 'inbound.json'), updates(command({ id: 23 }, 1, 'status'), command({ id: 1234 }, 2, 'status')))
    const channel = start(dir, fixture.argv, { TELEGRAM_ACCESS_MODE: '' })
    await channel.ready()
    await until(() => sends(dir).length === 2, 6000)
    expect(sends(dir).map(c => [c.payload.chat_id, c.payload.text])).toEqual([
      [23, 'Not paired. Send me a message to get a pairing code.'],
      [1234, 'Not paired. Send me a message to get a pairing code.'],
    ])
    await channel.close()
  }, 15000)

  test('a group’s own allowFrom of any shape but a list admits no member, and no list or an empty one admits every member, as before', async () => {
    const open = { requireMention: false }
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1'], groups: {
      '-100': { ...open, allowFrom: {} }, '-200': { ...open, allowFrom: '5' }, '-300': open, '-400': { ...open, allowFrom: [] },
      '-500': { ...open, allowFrom: ['5'] }, '-600': { ...open, allowFrom: null }, '-700': { ...open, allowFrom: 5 }, '-800': { ...open, allowFrom: ['6'] },
    } })
    const member = { id: 5, is_bot: false, first_name: 'Member', username: 'member' }
    const post = (chat: number, message_id: number) =>
      ({ message: { message_id, date: Math.floor(Date.now() / 1000), from: member, chat: { id: chat, type: 'supergroup', title: 'g' }, text: `in ${chat}` } })
    writeFileSync(join(dir, 'inbound.json'), updates(...[-100, -200, -300, -400, -500, -600, -700, -800].map((chat, i) => post(chat, i + 1)), dm(OWNER, 20, 'sentinel')))
    const channel = start(dir, fixture.argv)
    await channel.ready()
    await until(() => channel.inbound().length === 5, 6000)
    await wait(500)
    expect(channel.inbound().map(n => n.meta.chat_id).sort()).toEqual(['-300', '-400', '-500', '-600', '1'])
    await channel.close()
  }, 15000)

  // A map the owner wrote, odd entries included, which no server write may change.
  const MAP = { '7002': 'Fresh_PeerBot', '7003': 'peer_bat', '0012': 'x', '7004': { nested: ['a', 1] }, '-5': 'neg_peer_bot' }
  const expired = { old111: { senderId: '3', chatId: '3', createdAt: 0, expiresAt: 1, replies: 1 } }
  const read = (dir: string) => JSON.parse(readFileSync(join(dir, 'access.json'), 'utf8'))

  test.each([
    ['an expired pending code pruned by a message', { dmPolicy: 'allowlist', allowFrom: ['1'], groups: {}, pending: expired }, () => dm(OWNER, 1, 'hello'),
      (a: any) => Object.keys(a.pending).length === 0],
    ['an expired pending code pruned by /status', { dmPolicy: 'allowlist', allowFrom: ['1'], groups: {}, pending: expired }, () => command(OWNER, 1, 'status'),
      (a: any) => Object.keys(a.pending).length === 0],
    ['a new pairing code', { dmPolicy: 'pairing', allowFrom: ['1'], groups: {}, pending: {} }, () => dm({ id: 2 }, 1, 'hi'),
      (a: any) => Object.values(a.pending).some((p: any) => p.senderId === '2')],
    ['a pairing resend', { dmPolicy: 'pairing', allowFrom: ['1'], groups: {}, pending: { abc123: { senderId: '2', chatId: '2', createdAt: Date.now(), expiresAt: Date.now() + 3_600_000, replies: 1 } } },
      () => dm({ id: 2 }, 1, 'hi again'), (a: any) => a.pending.abc123?.replies === 2],
  ])('in live mode, %s keeps botUsernames as written', async (_, access, update, written) => {
    const dir = state({ ...access, botUsernames: MAP })
    writeFileSync(join(dir, 'inbound.json'), updates(update()))
    const channel = start(dir, fixture.argv, { TELEGRAM_ACCESS_MODE: '' })
    await channel.ready()
    await until(() => written(read(dir)), 6000)
    expect(read(dir).botUsernames).toEqual(MAP)
    await channel.close()
  }, 15000)

  test.each([
    ['a string', 'Fresh_PeerBot'],
    ['an array', ['7002', 'Fresh_PeerBot']],
    ['bad entries', { '7002': 5, x: null, '7003': ['a'], '7004': '@' }],
  ])('in live mode, a botUsernames that is %s is written back unchanged, with allowFrom intact and no corrupt copy', async (_, map) => {
    const dir = state({ dmPolicy: 'pairing', allowFrom: ['1', '7002'], groups: {}, pending: {}, botUsernames: map })
    writeFileSync(join(dir, 'inbound.json'), updates(dm({ id: 2 }, 1, 'hi')))
    const channel = start(dir, fixture.argv, { TELEGRAM_ACCESS_MODE: '' })
    await channel.ready()
    await until(() => Object.keys(read(dir).pending).length === 1, 6000)
    expect(read(dir).botUsernames).toEqual(map)
    expect(read(dir).allowFrom).toEqual(['1', '7002'])
    expect(readdirSync(dir).filter(f => f.includes('.corrupt-'))).toEqual([])
    await channel.close()
  }, 15000)

  test('in live mode, a bot added with its username while the server runs is reached without a restart', async () => {
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1'], groups: {}, pending: {} })
    const sender = start(dir, ['claude', '-p', 'hello'], {
      TELEGRAM_ACCESS_MODE: '',
      TELEGRAM_TEST_USERS: JSON.stringify({ 7060: peerBot(7060, 'sixty_peer_bot') }),
      TELEGRAM_TEST_CHATS: JSON.stringify({ unopened: [7060] }),
    })
    await sender.ready()
    expect(failure(await toolCall(sender, 'reply', { chat_id: '7060', text: 'x' }))).toContain('chat 7060 is not allowlisted')
    // What the access skill's bot verb writes for 7060.
    writeFileSync(join(dir, 'access.json'), JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['1', '7060'], groups: {}, pending: {}, botUsernames: { '7060': 'sixty_peer_bot' } }))
    expect((await toolCall(sender, 'reply', { chat_id: '7060', text: 'now' })).isError).not.toBe(true)
    expect(sends(dir).map(c => c.payload.chat_id)).toEqual([at('sixty_peer_bot')])
    expect(sender.stderr()).toContain(`opened chat 7060 by ${at('sixty_peer_bot')}`)
    await sender.close()
  }, 15000)
})
