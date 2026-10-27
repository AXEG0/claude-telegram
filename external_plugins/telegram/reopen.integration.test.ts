// A row its own transcript closed, which a newer entry opens again, and what
// leaves such a row as it is, in the running server with the offline Telegram
// fake.
import { afterEach, describe, expect, test } from 'bun:test'
import { AGENT_TICK_MS, CHAT_GAP_MS } from './agents.ts'
import { cleanup, conflicts } from './fixtures/harness.ts'
import { row, session } from './fixtures/session.ts'
import { apiError, attachment, requestBlob, userText } from './fixtures/transcript.ts'

afterEach(cleanup)

const isSend = (c: { method: string }) => c.method === 'sendMessage'

describe.skipIf(process.platform !== 'linux')('a row its transcript closed', () => {
  test('opens again on a newer user entry read before the message showed its ending', async () => {
    // Telegram holds its answer to the edit that shows the failure across a tick.
    const s = await session(conflicts([{ method: 'editMessageText', has: '1. ❌', times: 1, holdMs: AGENT_TICK_MS + 1000 }]))
    s.begin('a1', 'Long job')
    s.write('a1', userText('u1', Date.now(), 'Long job'))
    const sent = await s.next(t => row(t, 1).startsWith('1. ⏳'))
    s.write('a1', apiError('e1', Date.now(), 'overloaded'))
    const failed = await s.next(t => row(t, 1).startsWith('1. ❌'), sent.index + 1)
    s.write('a1', userText('u2', Date.now(), 'Continue'))
    const again = await s.next(t => row(t, 1).startsWith('1. ⏳'), failed.index + 1, 4 * AGENT_TICK_MS)
    expect(again.method).toBe('editMessageText')
    expect(again.payload.message_id).toBe(sent.message_id)
    expect(row(again.payload.text, 1)).toMatch(/^1\. ⏳ general-purpose · Long job · /)
    expect(s.panels().filter(isSend)).toHaveLength(1)
  }, 30000)

  test('opens again on a newer user entry read after the message showed its ending, under its old number', async () => {
    const s = await session()
    s.begin('a1', 'Long job')
    s.begin('a2', 'Other job')
    s.write('a1', userText('u1', Date.now(), 'Long job'))
    const sent = await s.next(t => row(t, 2).startsWith('2. ⏳'))
    s.write('a1', apiError('e1', Date.now(), 'overloaded'))
    const failed = await s.next(t => row(t, 1).startsWith('1. ❌'), sent.index + 1)
    // The failure is acknowledged and confirmed before the run goes on.
    await Bun.sleep(AGENT_TICK_MS + 500)
    s.write('a1', userText('u2', Date.now(), 'Continue'))
    const again = await s.next(t => row(t, 1).startsWith('1. ⏳'), failed.index + 1)
    expect(again.payload.message_id).toBe(sent.message_id)
    expect(row(again.payload.text, 1)).toMatch(/^1\. ⏳ general-purpose · Long job · /)
    expect(row(again.payload.text, 2)).toMatch(/^2\. ⏳ general-purpose · Other job · /)
    expect(s.panels().filter(isSend)).toHaveLength(1)
  }, 30000)

  test('a start read after the row opened again replaces it and its clock', async () => {
    const s = await session()
    const t0 = Date.now()
    s.begin('a1', 'Long job', t0 - 90_000)
    s.begin('a2', 'Other job')
    s.write('a1', userText('u1', t0 - 90_000, 'Long job'))
    const sent = await s.next(t => row(t, 1).startsWith('1. ⏳'))
    expect(row(sent.payload.text, 1)).toMatch(/ · 1m 3\ds$/)
    s.write('a1', apiError('e1', Date.now(), 'overloaded'))
    const failed = await s.next(t => row(t, 1).startsWith('1. ❌'), sent.index + 1)
    // The resumed run's prompt lands before its start hook writes.
    s.write('a1', userText('u2', Date.now(), 'Resume'))
    const reopened = await s.next(t => row(t, 1).startsWith('1. ⏳'), failed.index + 1)
    expect(row(reopened.payload.text, 1)).toMatch(/ · 1m \d+s$/)
    s.begin('a1', 'Resumed job')
    const replaced = await s.next(t => row(t, 1).includes('Resumed job'), reopened.index + 1)
    expect(row(replaced.payload.text, 1)).toMatch(/^1\. ⏳ general-purpose · Resumed job · Starting… · \ds$/)
    expect(replaced.payload.message_id).toBe(sent.message_id)
  }, 30000)

  test('a late StopFailure for a watched row is taken there and does not close the next resumed run', async () => {
    const s = await session()
    s.begin('a1', 'Long job')
    s.begin('a2', 'Other job')
    s.write('a1', userText('u1', Date.now(), 'Long job'))
    const sent = await s.next(t => row(t, 2).startsWith('2. ⏳'))
    s.write('a1', apiError('e1', Date.now(), 'overloaded'))
    const failed = await s.next(t => row(t, 1).startsWith('1. ❌'), sent.index + 1)
    await Bun.sleep(500)
    // A hook that ran late stamps its own clock, past the resumed run's start.
    s.stop('a1', Date.now() + 20_000, { outcome: 'failed', error: 'server_error' })
    const final = await s.next(t => row(t, 1).includes('(server_error)'), failed.index + 1)
    s.write('a1', userText('u2', Date.now(), 'Resume'))
    s.begin('a1', 'Resumed job')
    const resumed = await s.next(t => row(t, 1).includes('Resumed job'), final.index + 1)
    expect(row(resumed.payload.text, 1)).toMatch(/^1\. ⏳ general-purpose · Resumed job · /)
    await Bun.sleep(AGENT_TICK_MS + 500)
    expect(s.panels().slice(resumed.index + 1).filter(c => row(c.payload.text, 1).startsWith('1. ❌'))).toEqual([])
  }, 30000)

  test('an ending on its group\'s last running row that the next tick takes back leaves the group\'s message open', async () => {
    const s = await session()
    s.begin('a1', 'Long job')
    s.write('a1', userText('u1', Date.now(), 'Long job'))
    const sent = await s.next(t => row(t, 1).startsWith('1. ⏳'))
    // Past the chat's spacing, so the tick that reads the error also shows it,
    // and the next tick is the one that would confirm it.
    await Bun.sleep(Math.max(0, sent.at + CHAT_GAP_MS + 500 - Date.now()))
    s.write('a1', apiError('e1', Date.now(), 'overloaded'))
    const failed = await s.next(t => row(t, 1).startsWith('1. ❌'), sent.index + 1)
    // The nudge Claude Code sends after a cut refusal, before the next tick.
    s.write('a1', userText('u2', Date.now(), 'Continue'))
    const again = await s.next(t => row(t, 1).startsWith('1. ⏳'), failed.index + 1)
    expect(again.method).toBe('editMessageText')
    expect(again.payload.message_id).toBe(sent.message_id)
    expect(s.panels().filter(isSend)).toHaveLength(1)
  }, 30000)

  test('a SubagentStop read after a transcript failure ends the row done', async () => {
    const s = await session()
    s.begin('a1', 'Long job')
    s.begin('a2', 'Other job')
    s.write('a1', userText('u1', Date.now(), 'Long job'))
    const sent = await s.next(t => row(t, 2).startsWith('2. ⏳'))
    s.write('a1', apiError('e1', Date.now(), 'overloaded'))
    const failed = await s.next(t => row(t, 1).startsWith('1. ❌'), sent.index + 1)
    s.stop('a1')
    const done = await s.next(t => !row(t, 1).startsWith('1. ❌'), failed.index + 1)
    expect(row(done.payload.text, 1)).toMatch(/^1\. ✅ Done in \d+s · general-purpose · Long job$/)
  }, 30000)

  test('a SubagentStop read before the message showed the transcript failure ends the row done', async () => {
    // Telegram holds its answer to the edit that shows the failure across a tick.
    const s = await session(conflicts([{ method: 'editMessageText', has: '1. ❌', times: 1, holdMs: AGENT_TICK_MS + 1000 }]))
    s.begin('a1', 'Long job')
    s.begin('a2', 'Other job')
    s.write('a1', userText('u1', Date.now(), 'Long job'))
    const sent = await s.next(t => row(t, 2).startsWith('2. ⏳'))
    s.write('a1', apiError('e1', Date.now(), 'overloaded'))
    const failed = await s.next(t => row(t, 1).startsWith('1. ❌'), sent.index + 1)
    s.stop('a1')
    const done = await s.next(t => !row(t, 1).startsWith('1. ❌'), failed.index + 1, 4 * AGENT_TICK_MS)
    expect(row(done.payload.text, 1)).toMatch(/^1\. ✅ Done in \d+s · general-purpose · Long job$/)
  }, 30000)

  // Each tail below, written right after the failure showed, leaves the row
  // failed: no frame after that shows it running.
  const keeps = async (tail: (s: Awaited<ReturnType<typeof session>>) => void) => {
    const s = await session()
    s.begin('a1', 'Long job')
    s.write('a1', userText('u1', Date.now(), 'Long job'))
    const sent = await s.next(t => row(t, 1).startsWith('1. ⏳'))
    s.write('a1', apiError('e1', Date.now(), 'overloaded'))
    const failed = await s.next(t => row(t, 1).startsWith('1. ❌'), sent.index + 1)
    tail(s)
    await Bun.sleep(2 * AGENT_TICK_MS + 500)
    expect(s.panels().slice(failed.index + 1).filter(c => c.payload.text.includes('⏳'))).toEqual([])
    expect(s.panels().filter(isSend)).toHaveLength(1)
  }

  test('a tail of bookkeeping lines after the newest entry leaves the row as it is', async () => {
    await keeps(s => s.write('a1', attachment('b1', Date.now()), requestBlob(2000), { type: 'api-request', request: {} }))
  }, 30000)

  test('more than 256 KB of bookkeeping after the newest entry leaves the row as it is', async () => {
    await keeps(s => s.write('a1', ...Array.from({ length: 4 }, () => requestBlob(80 * 1024))))
  }, 30000)

  test('a newest user entry longer than 256 KB, whose tail starts mid-line, leaves the row as it is', async () => {
    await keeps(s => s.write('a1', userText('u2', Date.now(), 'y'.repeat(300 * 1024))))
  }, 30000)
})
