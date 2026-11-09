import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { calls, cleanup, conflicts, driveClock, start, state, STEP_MS, until, wait, type Call } from './fixtures/harness.ts'
import { runRegistered } from './fixtures/hooks.ts'
import fixture from './fixtures/channel-argv.json'
import failureHooks from './fixtures/failure-hooks.json'
import { AGENT_TICK_MS, appendAgentEvent, agentEventFile, CHAT_GAP_MS } from './agents.ts'
import { REFRESH_MS } from './typing.ts'

beforeEach(driveClock)
afterEach(cleanup)

// The owner's message, which makes the owner's chat the one the subagents
// message goes to, and starts the turn's typing there.
function ownerWrites(dir: string, text: string): void {
  writeFileSync(join(dir, 'inbound.json'), JSON.stringify([{
    update_id: 1,
    message: { message_id: 1, date: Math.floor(Date.now() / 1000), text,
      from: { id: 1, is_bot: false, first_name: 'Owner' }, chat: { id: 1, type: 'private' } },
  }]))
}

// A panel call's text: a plain call's text, or a rich call's paragraphs
// joined by line breaks.
const blocksOf = (c: Call): { type: string; text: unknown }[] | undefined =>
  Array.isArray(c.payload.rich_message?.blocks) ? c.payload.rich_message.blocks : undefined
const textOf = (c: Call): string | undefined => c.payload.text ?? blocksOf(c)?.map(b => b.text).join('\n')
const isPanel = (c: Call) => ['sendMessage', 'sendRichMessage', 'editMessageText'].includes(c.method) && !!textOf(c)?.startsWith('🤖 Subagents')
const panelSend = (c: Call) => c.method === 'sendMessage' && isPanel(c)
const panelEdit = (c: Call) => c.method === 'editMessageText' && isPanel(c)
// The fake logs a call when it arrives, a few milliseconds after the stream
// took the chat's slot for it.
const SLACK_MS = 50

// Real /proc ancestry, real MCP transport, and the production server. Only
// grammy's HTTP transport is fake; these tests never use the owner's bot.
describe.skipIf(process.platform !== 'linux')('the subagents message in the running server', () => {
  // Two subagents, one of them finished; the server's input then closes.
  async function twoRows(dir: string, env: Record<string, string> = {}) {
    ownerWrites(dir, 'closing test')
    const channel = start(dir, fixture.argv, env)
    await channel.ready()
    const file = agentEventFile(dir, channel.child.pid!)
    const base = join(dir, 'transcripts')
    mkdirSync(base)
    writeFileSync(join(base, 'agent-a1.meta.json'), JSON.stringify({ description: 'Long job' }))
    writeFileSync(join(base, 'agent-a2.meta.json'), JSON.stringify({ description: 'Short job' }))
    for (const id of ['a1', 'a2']) {
      appendAgentEvent(file, { t: Date.now(), event: 'start', agent_id: id, agent_type: 'general-purpose', agent_base: join(base, `agent-${id}`) })
    }
    await until(() => calls(dir).some(panelSend), AGENT_TICK_MS + 4000)
    return { channel, file }
  }

  test('closing the input makes one last edit: the running row reads as no longer followed and the finished row as it was', async () => {
    const dir = state()
    const { channel, file } = await twoRows(dir)
    appendAgentEvent(file, { t: Date.now(), event: 'stop', agent_id: 'a2' })
    await until(() => calls(dir).some(c => panelEdit(c) && c.payload.text.includes('\n2. ✅ Done in')), AGENT_TICK_MS + CHAT_GAP_MS + 4000)
    const shown = calls(dir).filter(panelEdit).at(-1)!
    const finished = shown.payload.text.split('\n')[2]
    expect(finished).toMatch(/^2\. ✅ Done in \d+s · general-purpose · Short job$/)
    const before = calls(dir).length
    await channel.close()
    const after = calls(dir).slice(before)
    expect(after.filter(c => c.method === 'sendMessage')).toEqual([])
    const closing = after.filter(c => c.method === 'editMessageText')
    expect(closing).toHaveLength(1)
    expect(closing[0]!.payload.message_id).toBe(calls(dir).find(panelSend)!.message_id)
    const lines = closing[0]!.payload.text.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('🤖 Subagents')
    expect(lines[1]).toMatch(/^1\. 🔌 No longer followed after \d+s · general-purpose · Long job · last: Starting…$/)
    expect(lines[2]).toBe(finished)
    // The chat's spacing holds for the closing edit too.
    expect(closing[0]!.at - shown.at).toBeGreaterThanOrEqual(CHAT_GAP_MS - SLACK_MS)
  }, 20000)

  test('an edit in flight as the input closes is answered first, then the closing edit goes at the chat\'s next slot, before the exit', async () => {
    const dir = state()
    // Telegram holds its answer to the edit that shows the finished row.
    const { channel, file } = await twoRows(dir, conflicts([{ method: 'editMessageText', has: '2. ✅ Done in', times: 1, holdMs: 1500 }]))
    appendAgentEvent(file, { t: Date.now(), event: 'stop', agent_id: 'a2' })
    await until(() => calls(dir).some(c => panelEdit(c) && c.payload.text.includes('\n2. ✅ Done in')), AGENT_TICK_MS + CHAT_GAP_MS + 4000)
    const inflight = calls(dir).filter(panelEdit).at(-1)!
    await channel.close()
    const after = calls(dir).filter(c => isPanel(c) && c.at > inflight.at)
    expect(after).toHaveLength(1)
    expect(after[0]!.method).toBe('editMessageText')
    expect(after[0]!.at - inflight.at).toBeGreaterThanOrEqual(CHAT_GAP_MS - SLACK_MS)
    expect(after[0]!.payload.text).toMatch(/\n1\. 🔌 No longer followed after \d+s · general-purpose · Long job · last: Starting…\n2\. ✅ Done in \d+s · general-purpose · Short job$/)
  }, 20000)

  test('a first send in flight as the input closes gives the closing edit its message, at the chat\'s next slot', async () => {
    const dir = state()
    ownerWrites(dir, 'closing test')
    // Telegram holds its answer to the message's first send.
    const channel = start(dir, fixture.argv, conflicts([{ method: 'sendMessage', has: '🤖 Subagents', times: 1, holdMs: 1500 }]))
    await channel.ready()
    const base = join(dir, 'transcripts')
    mkdirSync(base)
    writeFileSync(join(base, 'agent-a1.meta.json'), JSON.stringify({ description: 'Long job' }))
    appendAgentEvent(agentEventFile(dir, channel.child.pid!), { t: Date.now(), event: 'start', agent_id: 'a1', agent_type: 'general-purpose', agent_base: join(base, 'agent-a1') })
    await until(() => calls(dir).some(panelSend), AGENT_TICK_MS + 4000)
    const send = calls(dir).find(panelSend)!
    await channel.close()
    const after = calls(dir).filter(c => isPanel(c) && c.at > send.at)
    expect(after).toHaveLength(1)
    expect(after[0]!.method).toBe('editMessageText')
    expect(after[0]!.payload.message_id).toBe(send.message_id)
    expect(after[0]!.at - send.at).toBeGreaterThanOrEqual(CHAT_GAP_MS - SLACK_MS)
    expect(after[0]!.payload.text).toMatch(/^🤖 Subagents\n1\. 🔌 No longer followed after \d+s · general-purpose · Long job · last: Starting…$/)
  }, 20000)

  // The message's twelve seconds are its own: a reply into the same chat right
  // after its send goes to Telegram at once, and the message's next edit still
  // waits for its slot.
  test('a reply right after the subagents message\'s send goes out at once, and the message\'s next edit still comes 12 seconds after its send', async () => {
    const dir = state()
    const { channel, file } = await twoRows(dir)
    const send = calls(dir).find(panelSend)!
    const asked = Date.now()
    const r = (await channel.request('tools/call', { name: 'reply', arguments: { chat_id: '1', text: 'A reply inside the slot' } })).result
    expect(r.isError).toBeFalsy()
    const reply = calls(dir).find(c => c.method === 'sendMessage' && c.payload.text === 'A reply inside the slot')!
    expect(reply.at - asked).toBeLessThanOrEqual(2 * STEP_MS)
    expect(reply.at - send.at).toBeLessThan(12_000)
    appendAgentEvent(file, { t: Date.now(), event: 'stop', agent_id: 'a2' })
    await until(() => calls(dir).some(panelEdit), AGENT_TICK_MS + 12_000 + 4000)
    expect(calls(dir).find(panelEdit)!.at - send.at).toBeGreaterThanOrEqual(12_000 - SLACK_MS)
    await channel.close()
  }, 20000)

  // Nor do a button edit and typing wait for the message's slot: while its
  // twelve seconds since the send run, an edit of a reply's buttons alone goes
  // to Telegram at once, and the turn's typing keeps its own pace.
  test('while the subagents message\'s 12-second slot is taken, a buttons-only edit goes out at once and typing keeps its pace', async () => {
    const dir = state()
    const { channel, file } = await twoRows(dir)
    const send = calls(dir).find(panelSend)!
    const tool = async (name: string, args: object) => {
      const r = (await channel.request('tools/call', { name, arguments: args })).result
      expect(r.isError).toBeFalsy()
      return r.content[0].text as string
    }
    const id = Number(/\(id: (\d+)\)/.exec(await tool('reply', { chat_id: '1', text: 'Pick one', buttons: [['Yes', 'No']] }))![1])
    const asked = Date.now()
    expect(await tool('edit_message', { chat_id: '1', message_id: String(id), buttons: [['Yes']] })).toBe(`edited (id: ${id})`)
    const edit = calls(dir).find(c => c.method === 'editMessageReplyMarkup' && c.payload.message_id === id)!
    expect(edit.at - asked).toBeLessThanOrEqual(2 * STEP_MS)
    expect(edit.at - send.at).toBeLessThan(12_000)
    // A row ends, so the message has something new for its next slot.
    appendAgentEvent(file, { t: Date.now(), event: 'stop', agent_id: 'a2' })
    // The turn's typing goes on every few seconds through the slot.
    const typing = () => calls(dir).filter(c => c.method === 'sendChatAction' && c.payload.chat_id === '1' && c.at > send.at)
    await until(() => typing().some(c => c.at > send.at + 6_000), 12_000)
    const inSlot = typing().filter(c => c.at < send.at + 12_000)
    expect(inSlot.length).toBeGreaterThanOrEqual(2)
    expect(inSlot[0]!.at - send.at).toBeLessThanOrEqual(REFRESH_MS + 2 * STEP_MS)
    // No send or edit of the message came meanwhile: its slot was taken.
    expect(calls(dir).filter(c => isPanel(c) && c.at > send.at && c.at < send.at + 12_000 - SLACK_MS)).toEqual([])
    await until(() => calls(dir).some(panelEdit), AGENT_TICK_MS + 12_000 + 4000)
    expect(calls(dir).find(panelEdit)!.at - send.at).toBeGreaterThanOrEqual(12_000 - SLACK_MS)
    await channel.close()
  }, 20000)

  // The message as one rich message, with rich messages on, through the fake
  // Telegram: what the server sends and edits, and what it logs.
  const RICH_ON = { TELEGRAM_RICH_MESSAGES: 'true' }
  const REFUSED = { error_code: 400, description: 'Bad Request: RICH_MESSAGE_INVALID' }
  const lines = (channel: { stderr(): string }, text: string) => channel.stderr().split('\n').filter(l => l.includes(text))
  // Two running subagents, the first described with a link, a mention, a
  // hashtag and a command; resolves once the message's first call is made.
  async function running(dir: string, env: Record<string, string>) {
    ownerWrites(dir, 'rich test')
    const channel = start(dir, fixture.argv, env)
    await channel.ready()
    const file = agentEventFile(dir, channel.child.pid!)
    const base = join(dir, 'transcripts')
    mkdirSync(base)
    writeFileSync(join(base, 'agent-a1.meta.json'), JSON.stringify({ description: 'Read https://example.com/notes for @name #tag /cmd and *list* $each | gap' }))
    writeFileSync(join(base, 'agent-a2.meta.json'), JSON.stringify({ description: 'Short job' }))
    for (const id of ['a1', 'a2']) {
      appendAgentEvent(file, { t: Date.now(), event: 'start', agent_id: id, agent_type: 'general-purpose', agent_base: join(base, `agent-${id}`) })
    }
    await until(() => calls(dir).some(isPanel), AGENT_TICK_MS + 4000)
    return { channel, file, panels: () => calls(dir).filter(isPanel) }
  }

  test('with rich messages on, the message is one silent rich message of one plain paragraph, sent and edited as one, and the pieces Telegram types in its answer log nothing', async () => {
    const dir = state()
    const { channel, file, panels } = await running(dir, { ...RICH_ON,
      ...conflicts([{ method: ['sendRichMessage', 'editMessageText'], has: '🤖 Subagents', richEntities: true }]) })
    const send = panels()[0]!
    expect(send.method).toBe('sendRichMessage')
    expect(send.payload.disable_notification).toBe(true)
    expect(send.payload.rich_message.markdown).toBeUndefined()
    expect(blocksOf(send)).toEqual([{ type: 'paragraph', text: textOf(send) }])
    expect(textOf(send)).toMatch(/^🤖 Subagents\n1\. ⏳ general-purpose · Read https:\/\/example\.com\/notes for @name #tag \/cmd and \*list\* \$each \| gap · Starting… · \d+s\n2\. ⏳ general-purpose · Short job · Starting… · \d+s$/)
    appendAgentEvent(file, { t: Date.now(), event: 'stop', agent_id: 'a2' })
    await until(() => panels().some(c => c.method === 'editMessageText' && textOf(c)!.includes('\n2. ✅ Done in')), AGENT_TICK_MS + CHAT_GAP_MS + 4000)
    const edit = panels().find(c => c.method === 'editMessageText')!
    expect(edit.payload.message_id).toBe(send.message_id)
    expect(edit.payload.text).toBeUndefined()
    expect(blocksOf(edit)).toEqual([{ type: 'paragraph', text: textOf(edit) }])
    await channel.close()
    expect(lines(channel, 'subagents message:')).toEqual([])
    expect(calls(dir).some(c => c.method === 'sendMessage' && c.payload.text?.startsWith('🤖'))).toBe(false)
  }, 20000)

  test('with rich messages on, 45 running subagents whose rows pass 4,096 bytes show every row whole in the one rich paragraph', async () => {
    const dir = state()
    ownerWrites(dir, 'rich rows test')
    const channel = start(dir, fixture.argv, RICH_ON)
    await channel.ready()
    const file = agentEventFile(dir, channel.child.pid!)
    const base = join(dir, 'transcripts')
    mkdirSync(base)
    const description = 'Apply the two approved rule changes to the prompt files of each agent'
    for (let i = 0; i < 45; i++) writeFileSync(join(base, `agent-w${i}.meta.json`), JSON.stringify({ description }))
    for (let i = 0; i < 45; i++) {
      appendAgentEvent(file, { t: Date.now(), event: 'start', agent_id: `w${i}`, agent_type: 'general-purpose', agent_base: join(base, `agent-w${i}`) })
    }
    const all = (c: Call) => isPanel(c) && textOf(c)!.split('\n').length === 46
    await until(() => calls(dir).some(all), AGENT_TICK_MS + CHAT_GAP_MS + 4000)
    const call = calls(dir).find(all)!
    expect(call.method === 'sendRichMessage' || call.method === 'editMessageText').toBe(true)
    expect(blocksOf(call)).toHaveLength(1)
    expect(Buffer.byteLength(textOf(call)!)).toBeGreaterThan(4096)
    for (const row of textOf(call)!.split('\n').slice(1)) expect(row).toMatch(new RegExp(`^\\d+\\. ⏳ general-purpose · ${description} · Starting… · \\d+s$`))
    await channel.close()
  }, 20000)

  test('with rich messages off, the message goes only as plain text', async () => {
    const dir = state()
    const { channel, file, panels } = await running(dir, {})
    appendAgentEvent(file, { t: Date.now(), event: 'stop', agent_id: 'a2' })
    await until(() => panels().some(c => c.method === 'editMessageText'), AGENT_TICK_MS + CHAT_GAP_MS + 4000)
    await channel.close()
    expect(panels().length).toBeGreaterThanOrEqual(3)
    expect(panels().every(c => (c.method === 'sendMessage' || c.method === 'editMessageText') && typeof c.payload.text === 'string' && c.payload.rich_message === undefined)).toBe(true)
  }, 20000)

  test('a refused rich send is logged, and the next panel call, a slot later, sends the message plain and silent', async () => {
    const dir = state()
    const { channel, panels } = await running(dir, { ...RICH_ON,
      ...conflicts([{ method: 'sendRichMessage', has: '🤖 Subagents', times: 1, error: REFUSED }]) })
    const refused = panels()[0]!
    expect(refused).toMatchObject({ method: 'sendRichMessage', refused: REFUSED.description })
    await until(() => panels().length >= 2, AGENT_TICK_MS + CHAT_GAP_MS + 4000)
    const next = panels()[1]!
    expect(next.method).toBe('sendMessage')
    expect(next.payload.disable_notification).toBe(true)
    expect(next.at - refused.at).toBeGreaterThanOrEqual(CHAT_GAP_MS - SLACK_MS)
    expect(lines(channel, 'subagents message:').map(l => l.slice(0, l.indexOf('slot:') + 5)))
      .toEqual(['telegram channel: subagents message: rich send refused, plain from the next slot:'])
    await channel.close()
  }, 20000)

  test('an answer with no rich text logs one line and changes nothing, and a cut Telegram makes logs one line over two cut edits', async () => {
    const dir = state()
    const { channel, panels } = await running(dir, { ...RICH_ON, ...conflicts([
      { method: 'sendRichMessage', has: '🤖 Subagents', times: 1, richless: true },
      { method: 'editMessageText', has: '🤖 Subagents', times: 2, richCut: 40 },
    ]) })
    const send = panels()[0]!
    await until(() => panels().filter(c => c.method === 'editMessageText').length >= 3, 3 * CHAT_GAP_MS + AGENT_TICK_MS + 4000)
    const later = panels().slice(1)
    expect(later.every(c => c.method === 'editMessageText' && c.payload.message_id === send.message_id && blocksOf(c) !== undefined)).toBe(true)
    await channel.close()
    expect(lines(channel, 'subagents message:')).toEqual([
      `telegram channel: subagents message: Telegram's answer holds no rich text to compare (message ${send.message_id})`,
      expect.stringMatching(new RegExp(`^telegram channel: subagents message: Telegram stored \\d+ of \\d+ bytes \\(message ${send.message_id}\\)$`)),
    ])
  }, 30000)

  test('five rich edits in a row answered with no rich text log one line, and the next frame still edits the message as a rich message', async () => {
    const dir = state()
    const { channel, panels } = await running(dir, { ...RICH_ON,
      ...conflicts([{ method: 'editMessageText', has: '🤖 Subagents', times: 5, richless: true }]) })
    const send = panels()[0]!
    await until(() => panels().filter(c => c.method === 'editMessageText').length >= 6, 6 * CHAT_GAP_MS + AGENT_TICK_MS + 4000)
    const edits = panels().filter(c => c.method === 'editMessageText')
    expect(edits[5]!.payload.message_id).toBe(send.message_id)
    expect(blocksOf(edits[5]!)).toBeDefined()
    expect(panels().filter(c => c.method !== 'editMessageText')).toEqual([send])
    await channel.close()
    expect(lines(channel, 'subagents message:')).toEqual([
      `telegram channel: subagents message: Telegram's answer holds no rich text to compare (message ${send.message_id})`,
    ])
  }, 60000)

  // The registered hooks with the inputs Claude Code sent for a subagent whose
  // model call failed, written for the server's own Claude Code process.
  for (const kind of ['an Agent call', 'a workflow'] as const) {
    test(`a subagent of ${kind} that fails on an API error shows as failed within one refresh`, async () => {
      const dir = state()
      ownerWrites(dir, 'failure test')
      const channel = start(dir, fixture.argv)
      await channel.ready()
      const [startInput, failure] = kind === 'a workflow'
        ? [failureHooks.workflow_subagent_start, failureHooks.workflow_subagent_stop_failure]
        : [failureHooks.subagent_start, failureHooks.subagent_stop_failure]
      const projects = join(dir, 'projects')
      const transcript = join(projects, `${startInput.session_id}.jsonl`)
      const folder = kind === 'a workflow'
        ? join(projects, startInput.session_id, 'subagents', 'workflows', 'wf_probe0-0001')
        : join(projects, startInput.session_id, 'subagents')
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, `agent-${startInput.agent_id}.meta.json`), JSON.stringify({ agentType: 'failing-probe', description: 'Say hello' }))
      writeFileSync(join(folder, `agent-${startInput.agent_id}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: 'Say hello.' } }) + '\n')
      const env = { TELEGRAM_STATE_DIR: dir, CLAUDE_PID: String(channel.child.pid) }
      expect(runRegistered('SubagentStart', { ...startInput, transcript_path: transcript }, env)).toEqual([0])
      await until(() => calls(dir).some(panelSend), AGENT_TICK_MS + 4000)
      const send = calls(dir).find(panelSend)!
      expect(send.payload.text).toMatch(/^🤖 Subagents\n1\. ⏳ failing-probe · Say hello · Starting… · \d+s$/)
      // Past the chat's spacing, so only the stream's refresh can hold the edit.
      await wait(Math.max(0, send.at + CHAT_GAP_MS - Date.now()))
      expect(runRegistered('StopFailure', { ...failure, transcript_path: transcript }, env)).toEqual([0, 0])
      const failedAt = Date.now()
      await until(() => calls(dir).some(panelEdit), AGENT_TICK_MS + 4000)
      const edit = calls(dir).find(panelEdit)!
      expect(edit.payload.text).toMatch(/^🤖 Subagents\n1\. ❌ Failed after \d+s \(model_not_found\) · failing-probe · Say hello$/)
      expect(edit.at - failedAt).toBeLessThanOrEqual(AGENT_TICK_MS + 500)
      await channel.close()
    }, 20000)
  }

  test('a subagent\'s failure leaves the turn\'s typing on, and the main session\'s failure ends it', async () => {
    const dir = state()
    ownerWrites(dir, 'typing test')
    const channel = start(dir, fixture.argv)
    await channel.ready()
    const typing = () => calls(dir).filter(c => c.method === 'sendChatAction' && c.payload.chat_id === '1')
    await until(() => typing().length > 0, 6000)
    const env = { TELEGRAM_STATE_DIR: dir, CLAUDE_PID: String(channel.child.pid) }
    expect(runRegistered('StopFailure', failureHooks.subagent_stop_failure, env)).toEqual([0, 0])
    const failedAt = Date.now()
    // A whole typing tick after the subagent's failure, the chat still types.
    await until(() => typing().some(c => c.at > failedAt + REFRESH_MS), 2 * REFRESH_MS + 2000)
    expect(runRegistered('StopFailure', failureHooks.main_stop_failure, env)).toEqual([0, 0])
    const endedAt = Date.now()
    await wait(2 * REFRESH_MS)
    expect(typing().filter(c => c.at > endedAt + 100)).toEqual([])
    await channel.close()
  }, 30000)
})
