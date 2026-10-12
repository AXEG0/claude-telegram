import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import fixture from './fixtures/channel-argv.json'
import { AGENT_TICK_MS, appendAgentEvent, agentEventFile } from './agents.ts'
import { idleText, RECOVERED_TEXT, stuckText } from './alerts.ts'
import { REFRESH_MS } from './typing.ts'

const children: ChildProcessWithoutNullStreams[] = []
const dirs: string[] = []
function state(access: object = { dmPolicy: 'allowlist', allowFrom: ['1'] }): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-polling-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'access.json'), JSON.stringify(access))
  return dir
}
async function until(check: () => boolean, timeout = 4000): Promise<void> {
  const end = Date.now() + timeout
  while (!check()) {
    if (Date.now() > end) throw new Error('subprocess did not reach expected state')
    await Bun.sleep(10)
  }
}
function calls(dir: string): { pid: number; method: string; payload: any }[] {
  const file = join(dir, 'api.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}
function start(dir: string, argv: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [join(import.meta.dir, 'fixtures', 'claude-parent.ts'), ...argv.slice(1)], {
    argv0: argv[0],
    env: {
      ...process.env,
      TELEGRAM_STATE_DIR: dir,
      TELEGRAM_BOT_TOKEN: '123:test-token',
      TELEGRAM_ACCESS_MODE: 'static',
      TELEGRAM_RICH_MESSAGES: 'false',
      TELEGRAM_STT_OPENAI_KEY: '',
      TELEGRAM_TEST_API_LOG: join(dir, 'api.jsonl'),
      TELEGRAM_TEST_INBOUND: join(dir, 'inbound.json'),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  let output = ''
  let id = 0
  const replies = new Map<number, (value: any) => void>()
  // Notifications the server sent Claude, such as inbound channel messages.
  const notifications: { method: string; params: any }[] = []
  child.stdout.on('data', chunk => {
    output += chunk
    let newline: number
    while ((newline = output.indexOf('\n')) >= 0) {
      const message = JSON.parse(output.slice(0, newline))
      output = output.slice(newline + 1)
      if (message.id === undefined) notifications.push(message)
      replies.get(message.id)?.(message)
      replies.delete(message.id)
    }
  })
  async function request(method: string, params: object) {
    const next = ++id
    const response = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out: ${stderr}`)), 4000)
      replies.set(next, value => { clearTimeout(timer); resolve(value) })
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n')
    return response
  }
  return {
    child, request, stderr: () => stderr,
    notifications,
    inbound: () => notifications.filter(n => n.method === 'notifications/claude/channel').map(n => n.params),
    async ready() {
      await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    },
    async close() { child.stdin.end(); await until(() => child.exitCode !== null) },
  }
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end()
      await until(() => child.exitCode !== null || child.signalCode !== null)
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// Real /proc ancestry, real MCP transport, and the production server. Only
// grammy's HTTP transport is fake; these tests never use the owner's bot.
describe.skipIf(process.platform !== 'linux')('polling ownership in the running server', () => {
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
    // A file's mtime comes from the kernel's coarse clock, which can trail
    // Date.now() by a few milliseconds; the mark must land after the alert.
    await Bun.sleep(50)
    mkdirSync(join(dir, 'turns'), { recursive: true })
    writeFileSync(join(dir, 'turns', `busy-${channel.child.pid}`), '')
    await until(() => alerts().length > 1, 2 * REFRESH_MS + 4000)
    expect(alerts().map(c => c.payload.text)).toEqual([idleText(6000), RECOVERED_TEXT])
    expect(calls(dir).filter(c => c.method === 'sendMessage' && c.payload.chat_id !== '77')).toEqual([])
    await channel.close()
  }, 35000)

  test('a send-only instance never sends the idle alert', async () => {
    const dir = state()
    const sender = start(dir, ['claude', 'mcp', 'list'], { TELEGRAM_ALERT_CHAT: '77', TELEGRAM_ALERT_IDLE_MINUTES: '0.01' })
    await sender.ready()
    await Bun.sleep(600 + 2 * REFRESH_MS)
    expect(calls(dir)).toEqual([])
    expect(sender.child.exitCode).toBeNull()
    await sender.close()
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
    expect(calls(dir).filter(call => call.pid === send.pid).map(call => call.method)).toEqual(['sendMessage'])
    await sender.close()
    expect(readFileSync(join(dir, 'bot.pid'), 'utf8')).toBe(holder)
    expect(statSync(join(dir, 'bot.pid')).mtimeMs).toBe(before)
    expect(JSON.parse(readFileSync(join(dir, 'poll-heartbeat.json'), 'utf8')).pid).toBe(Number(holder))
    expect(channel.child.exitCode).toBeNull()
    expect(sender.stderr()).toContain('send-only')
    await channel.close()
    expect(existsSync(join(dir, 'bot.pid'))).toBe(false)
  })

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
})
