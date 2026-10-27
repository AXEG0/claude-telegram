import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { calls, cleanup, conflicts, start, state, until, type Call } from './fixtures/harness.ts'
import { runRegistered } from './fixtures/hooks.ts'
import fixture from './fixtures/channel-argv.json'
import failureHooks from './fixtures/failure-hooks.json'
import { AGENT_TICK_MS, appendAgentEvent, agentEventFile, CHAT_GAP_MS } from './agents.ts'
import { REFRESH_MS } from './typing.ts'

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

const isPanel = (c: Call) => (c.method === 'sendMessage' || c.method === 'editMessageText') && c.payload.text?.startsWith('🤖 Subagents')
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
    await until(() => calls(dir).some(c => panelEdit(c) && c.payload.text.includes('\n2. ✅ Done in')), AGENT_TICK_MS + 4000)
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
    await until(() => calls(dir).some(c => panelEdit(c) && c.payload.text.includes('\n2. ✅ Done in')), AGENT_TICK_MS + 4000)
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
      await Bun.sleep(Math.max(0, send.at + CHAT_GAP_MS - Date.now()))
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
    await Bun.sleep(2 * REFRESH_MS)
    expect(typing().filter(c => c.at > endedAt + 100)).toEqual([])
    await channel.close()
  }, 30000)
})
