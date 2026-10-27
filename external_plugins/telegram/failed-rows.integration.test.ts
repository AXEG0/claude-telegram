// A subagent whose run ends on an API error, read from its own transcript or
// from the StopFailure hook, in the running server with the offline Telegram
// fake.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { AGENT_TICK_MS } from './agents.ts'
import failureHooks from './fixtures/failure-hooks.json'
import { cleanup } from './fixtures/harness.ts'
import { runRegistered } from './fixtures/hooks.ts'
import { row, session, type Session } from './fixtures/session.ts'
import { apiError, interruption, line, toolCall, userText } from './fixtures/transcript.ts'

afterEach(cleanup)

// The registered hooks' subagent, its files in Claude Code's own layout: the
// Agent call's subagent of the recorded inputs.
function hookAgent(s: Session) {
  const input = failureHooks.subagent_start
  const projects = join(s.dir, 'projects')
  const transcriptPath = join(projects, `${input.session_id}.jsonl`)
  const folder = join(projects, input.session_id, 'subagents')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, `agent-${input.agent_id}.meta.json`), JSON.stringify({ agentType: 'failing-probe', description: 'Say hello' }))
  const transcript = join(folder, `agent-${input.agent_id}.jsonl`)
  const env = { TELEGRAM_STATE_DIR: s.dir, CLAUDE_PID: String(s.channel.child.pid) }
  return {
    transcript,
    entries: (...entries: object[]) => writeFileSync(transcript, entries.map(line).join('')),
    start: () => runRegistered('SubagentStart', { ...input, transcript_path: transcriptPath }, env),
    fail: (error = 'model_not_found') => runRegistered('StopFailure', { ...failureHooks.subagent_stop_failure, error, transcript_path: transcriptPath }, env),
  }
}

describe.skipIf(process.platform !== 'linux')('a subagent that ends on an API error', () => {
  test('a transcript that ends on Claude Code\'s API-error entry closes its row as failed, with the error\'s class', async () => {
    const s = await session()
    s.begin('a1', 'Review the plan')
    s.write('a1', userText('u1', Date.now(), 'Review the plan'))
    await s.next(t => row(t, 1).startsWith('1. ⏳'))
    s.write('a1', toolCall('c1', Date.now(), 'Checking gate', 1500), apiError('e1', Date.now(), 'rate_limit'))
    const failed = await s.next(t => row(t, 1).startsWith('1. ❌'))
    expect(failed.payload.text).toMatch(/^🤖 Subagents\n1\. ❌ Failed after \d+s \(rate_limit\) · general-purpose · Review the plan · 1\.5k tokens$/)
  }, 30000)

  test('an earlier run\'s error followed by the resumed run\'s prompt leaves the row running', async () => {
    const s = await session()
    const t0 = Date.now()
    s.begin('a1', 'Resumed run')
    s.write('a1', userText('u1', t0 - 30_000, 'First run'), apiError('e1', t0 - 20_000, 'server_error'), userText('u2', t0 - 1000, 'Go on'))
    const first = await s.next(() => true)
    expect(row(first.payload.text, 1)).toMatch(/^1\. ⏳ general-purpose · Resumed run · /)
    s.write('a1', toolCall('c1', Date.now(), 'Reading notes', 900))
    const later = await s.next(t => row(t, 1).includes('Reading notes'), first.index + 1)
    expect(row(later.payload.text, 1)).toMatch(/^1\. ⏳ general-purpose · Resumed run · Reading notes · \d+s · 900 tokens$/)
    expect(s.panels().some(c => c.payload.text.includes('❌'))).toBe(false)
  }, 30000)

  test('a StopFailure stamped before its own start still ends with the row failed, through the transcript', async () => {
    const s = await session()
    const t0 = Date.now()
    // The stop hook's clock ran ahead of a slower start hook's.
    s.stop('a1', t0 - 2000, { outcome: 'failed', error: 'model_not_found' })
    s.begin('a1', 'Slow start', t0)
    s.write('a1', userText('u1', t0, 'Slow start'))
    await s.next(t => row(t, 1).startsWith('1. ⏳'))
    s.write('a1', apiError('e1', Date.now(), 'model_not_found'))
    const failed = await s.next(t => row(t, 1).startsWith('1. ❌'))
    expect(row(failed.payload.text, 1)).toMatch(/^1\. ❌ Failed after \d+s \(model_not_found\) · general-purpose · Slow start$/)
  }, 30000)

  test('the class unknown reads as no class, from the hook and from the transcript alike', async () => {
    const s = await session()
    const agent = hookAgent(s)
    agent.entries(userText('u1', Date.now(), 'Say hello'))
    expect(agent.start()).toEqual([0])
    s.begin('a2', 'Second job')
    s.write('a2', userText('u2', Date.now(), 'Second job'))
    await s.next(t => row(t, 1).startsWith('1. ⏳') && row(t, 2).startsWith('2. ⏳'))
    expect(agent.fail('unknown')).toEqual([0, 0])
    s.write('a2', apiError('e2', Date.now(), 'unknown'))
    const failed = await s.next(t => row(t, 1).startsWith('1. ❌') && row(t, 2).startsWith('2. ❌'))
    expect(row(failed.payload.text, 1)).toMatch(/^1\. ❌ Failed after \d+s · failing-probe · Say hello$/)
    expect(row(failed.payload.text, 2)).toMatch(/^2\. ❌ Failed after \d+s · general-purpose · Second job$/)
  }, 30000)

  test('an earlier run\'s StopFailure read after a resumed start, stamped with its error entry\'s time, leaves the resumed row running', async () => {
    const s = await session()
    const agent = hookAgent(s)
    const t0 = Date.now()
    agent.entries(userText('u1', t0 - 30_000, 'Say hello'), apiError('e1', t0 - 20_000, 'model_not_found'), userText('u2', t0 - 1000, 'Say hello again'))
    expect(agent.start()).toEqual([0])
    const first = await s.next(t => row(t, 1).startsWith('1. ⏳'))
    // The earlier run's hook, late: it finds that run's error entry.
    expect(agent.fail()).toEqual([0, 0])
    await Bun.sleep(2 * AGENT_TICK_MS + 500)
    expect(s.panels().slice(first.index + 1).filter(c => row(c.payload.text, 1).startsWith('1. ❌'))).toEqual([])
    await s.channel.close()
    expect(row(s.panels().at(-1)!.payload.text, 1)).toMatch(/^1\. 🔌 No longer followed after \d+s · failing-probe · Say hello · last: /)
  }, 30000)

  test('the interruption Claude Code writes when its own process shuts down leaves the row running', async () => {
    const s = await session()
    s.begin('a1', 'Long job')
    s.write('a1', userText('u1', Date.now(), 'Long job'))
    const first = await s.next(t => row(t, 1).startsWith('1. ⏳'))
    s.write('a1', interruption('i1', Date.now(), true))
    await Bun.sleep(2 * AGENT_TICK_MS + 500)
    expect(s.panels().slice(first.index + 1).filter(c => c.payload.text.includes('⏹'))).toEqual([])
    await s.channel.close()
    expect(row(s.panels().at(-1)!.payload.text, 1)).toMatch(/^1\. 🔌 No longer followed after \d+s · general-purpose · Long job · last: /)
  }, 30000)

  test('a failed row keeps the token count of its last real request', async () => {
    const s = await session()
    s.begin('a1', 'Count tokens')
    s.write('a1', userText('u1', Date.now(), 'Count tokens'))
    await s.next(t => row(t, 1).startsWith('1. ⏳'))
    s.write('a1', toolCall('c1', Date.now(), 'Checking gate', 1500), apiError('e1', Date.now(), 'rate_limit'))
    s.stop('a1', Date.now(), { outcome: 'failed', error: 'rate_limit' })
    const failed = await s.next(t => row(t, 1).startsWith('1. ❌'))
    expect(row(failed.payload.text, 1)).toMatch(/^1\. ❌ Failed after \d+s \(rate_limit\) · general-purpose · Count tokens · 1\.5k tokens$/)
  }, 30000)
})
