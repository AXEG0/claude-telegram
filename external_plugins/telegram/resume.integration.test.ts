// A subagent resumed after its run ended in its transcript, a stop hook after
// its group ended, and a transcript tail with no whole entry, in the running
// server with the offline Telegram fake.
import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'path'
import { AGENT_TICK_MS, appendAgentEvent, CHAT_GAP_MS, CLOCK_REFRESH_MS } from './agents.ts'
import { calls, cleanup, deliver, state, until } from './fixtures/harness.ts'
import { row, session, WAIT_MS, type Session } from './fixtures/session.ts'
import { apiError, assistantText, requestBlob, userText } from './fixtures/transcript.ts'

afterEach(cleanup)

const isSend = (c: { method: string }) => c.method === 'sendMessage'

// Two people who may write to the bot, each in their own private chat, with a
// fresh message id for each send.
async function twoChats(): Promise<Session> {
  const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1', '2'] })
  return session({ TELEGRAM_TEST_CHATS: JSON.stringify({ ids: 7 }) }, dir)
}

// The second person writes, which makes their chat the one new rows go to.
async function otherChatWrites(s: Session): Promise<void> {
  deliver(s.dir, [{ update_id: 2, message: { message_id: 2, date: Math.floor(Date.now() / 1000), text: 'hello',
    from: { id: 2, is_bot: false, first_name: 'Other' }, chat: { id: 2, type: 'private' } } }])
  await until(() => calls(s.dir).some(c => c.method === 'sendChatAction' && c.payload.chat_id === '2'), WAIT_MS)
}

// Shows a1 failed from its transcript while a2 runs, in chat 1's message.
async function failA1(s: Session) {
  s.begin('a1', 'Long job')
  s.begin('a2', 'Other job')
  s.write('a1', userText('u1', Date.now(), 'Long job'))
  const sent = await s.next(t => row(t, 2).startsWith('2. ⏳'))
  await Bun.sleep(Math.max(0, sent.at + CHAT_GAP_MS + 500 - Date.now()))
  s.write('a1', apiError('e1', Date.now(), 'overloaded'))
  const failed = await s.next(t => row(t, 1).startsWith('1. ❌'), sent.index + 1)
  return { sent, failed }
}

// After the resumed run and a2 end, chat 1's message shows both done, no other
// message was ever sent, and the message takes no further edit.
async function endsInPlace(s: Session, sentId: number, after: number) {
  s.stop('a2')
  s.stop('a1')
  const done = await s.next(t => row(t, 1).startsWith('1. ✅') && row(t, 2).startsWith('2. ✅'), after)
  expect(row(done.payload.text, 1)).toMatch(/^1\. ✅ Done in \d+s · general-purpose · Resumed job$/)
  expect(done.payload.message_id).toBe(sentId)
  await Bun.sleep(CLOCK_REFRESH_MS + AGENT_TICK_MS)
  expect(s.panels().slice(done.index + 1)).toEqual([])
  expect(s.panels().filter(c => c.payload.chat_id !== '1')).toEqual([])
  expect(s.panels().filter(isSend)).toHaveLength(1)
}

describe.skipIf(process.platform !== 'linux')('a subagent resumed after its run ended in its transcript', () => {
  test('a run resumed after another chat wrote takes its earlier run\'s place in the earlier chat\'s message', async () => {
    const s = await twoChats()
    const { sent, failed } = await failA1(s)
    // The failure is shown and confirmed; then the other person writes.
    await Bun.sleep(AGENT_TICK_MS + 500)
    await otherChatWrites(s)
    s.write('a1', userText('u2', Date.now(), 'Resume'))
    s.begin('a1', 'Resumed job')
    const resumed = await s.next(t => row(t, 1).includes('Resumed job'), failed.index + 1)
    expect(resumed.payload.chat_id).toBe('1')
    expect(resumed.payload.message_id).toBe(sent.message_id)
    expect(row(resumed.payload.text, 1)).toMatch(/^1\. ⏳ general-purpose · Resumed job · /)
    await endsInPlace(s, sent.message_id!, resumed.index + 1)
  }, 60000)

  test('a run whose resumed prompt is read a tick before its start takes its earlier run\'s place, with no row left behind', async () => {
    const s = await twoChats()
    const { sent, failed } = await failA1(s)
    await otherChatWrites(s)
    // The prompt reopens the earlier row before the start hook writes.
    s.write('a1', userText('u2', Date.now(), 'Resume'))
    const reopened = await s.next(t => row(t, 1).startsWith('1. ⏳'), failed.index + 1)
    s.begin('a1', 'Resumed job')
    const resumed = await s.next(t => row(t, 1).includes('Resumed job'), reopened.index + 1)
    expect(resumed.payload.chat_id).toBe('1')
    expect(resumed.payload.message_id).toBe(sent.message_id)
    await endsInPlace(s, sent.message_id!, resumed.index + 1)
  }, 60000)

  test('a server that starts after a run was resumed shows the resumed run on its own clock', async () => {
    const s = await session()
    const t0 = Date.now() - 10 * 60_000
    // The backlog: the first run ended on an API error in its transcript, and
    // the run resumed a minute ago.
    s.write('a1', userText('u1', t0, 'Long job'), apiError('e1', t0 + 30_000, 'overloaded'), userText('u2', Date.now() - 61_000, 'Resume'))
    s.begin('a1', 'Long job', t0)
    appendAgentEvent(s.file, { t: Date.now() - 60_000, event: 'start', agent_id: 'a1', agent_type: 'general-purpose', agent_base: join(s.base, 'agent-a1') })
    const first = await s.next(() => true)
    expect(row(first.payload.text, 1)).toMatch(/^1\. ⏳ general-purpose · Long job · Starting… · 1m \ds$/)
  }, 30000)
})

describe.skipIf(process.platform !== 'linux')('a failure read from the transcript', () => {
  test('a SubagentStop after the group of its transcript failure ended edits that message to done', async () => {
    const s = await session()
    s.begin('a1', 'Long job')
    s.write('a1', userText('u1', Date.now(), 'Long job'))
    const sent = await s.next(t => row(t, 1).startsWith('1. ⏳'))
    await Bun.sleep(Math.max(0, sent.at + CHAT_GAP_MS + 500 - Date.now()))
    s.write('a1', apiError('e1', Date.now(), 'overloaded'))
    const failed = await s.next(t => row(t, 1).startsWith('1. ❌'), sent.index + 1)
    // The next tick confirms the failure and ends the group.
    await Bun.sleep(2 * AGENT_TICK_MS + 500)
    expect(s.panels().slice(failed.index + 1)).toEqual([])
    s.stop('a1')
    const done = await s.next(t => row(t, 1).startsWith('1. ✅'), failed.index + 1)
    expect(done.method).toBe('editMessageText')
    expect(done.payload.message_id).toBe(sent.message_id)
    expect(done.payload.text).toMatch(/^🤖 Subagents\n1\. ✅ Done in \d+s · general-purpose · Long job$/)
  }, 30000)

  test('a tail with no whole entry after the failure confirms nothing, so the answer that follows reopens the row in the same message', async () => {
    const s = await session()
    s.begin('a1', 'Long job')
    s.write('a1', userText('u1', Date.now(), 'Long job'))
    const sent = await s.next(t => row(t, 1).startsWith('1. ⏳'))
    await Bun.sleep(Math.max(0, sent.at + CHAT_GAP_MS + 500 - Date.now()))
    s.write('a1', apiError('e1', Date.now(), 'overloaded'))
    const failed = await s.next(t => row(t, 1).startsWith('1. ❌'), sent.index + 1)
    // About 400 KB of request records, before the next tick: the tail holds
    // no whole user or assistant entry.
    s.write('a1', ...Array.from({ length: 5 }, () => requestBlob(80 * 1024)))
    // Two ticks: one reads that tail, the next finds the file unchanged.
    await Bun.sleep(2 * AGENT_TICK_MS + 500)
    s.write('a1', assistantText('t1', Date.now(), 'The answer'))
    const again = await s.next(t => row(t, 1).startsWith('1. ⏳'), failed.index + 1)
    expect(again.method).toBe('editMessageText')
    expect(again.payload.message_id).toBe(sent.message_id)
    expect(row(again.payload.text, 1)).toMatch(/^1\. ⏳ general-purpose · Long job · ✍️ Writing… · /)
    expect(s.panels().filter(isSend)).toHaveLength(1)
  }, 30000)
})
