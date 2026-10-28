// A main-session turn that ends on an API error, in the running server with
// the offline Telegram fake: the notice, its run and back to normal. The
// hooks run as registered, so these tests also prove their registration.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import failureHooks from './fixtures/failure-hooks.json'
import { CREDITS, failing, notice, NOTHING_MS, RESTORED_TEXT } from './fixtures/failing.ts'
import { cleanup, deliver, driveClock, state, until, wait } from './fixtures/harness.ts'
import turnHooks from './fixtures/turn-hooks.json'
import { apiError, prompt, recorded, reply, upTo } from './fixtures/turns.ts'

beforeEach(driveClock)
afterEach(cleanup)

// Chat 1's turn and its 402 are lines 1 to 13, chat 3's own turn lines 53 to 60.
const own = recorded('start-absorbed-own-turns')

describe.skipIf(process.platform !== 'linux')('a turn that ends on an error', () => {
  test('sends the chat whose message started it one notice with the error\'s class and text, the recorded 402 as Type: unknown', async () => {
    const s = await failing()
    // A rate limit in chat 1's turn.
    const limited = 'API Error: 429 rate limited'
    s.write(prompt('p1', Date.now() - 500, '1', 1), apiError('e1', Date.now() - 50, limited, 'rate_limit'))
    expect(s.fail(limited, 'rate_limit')).toEqual([0, 0])
    // The recorded 402 in chat 3's own turn.
    s.next().recorded(own.slice(52, 60), 7)
    expect(s.fail()).toEqual([0, 0])
    expect(await s.arrived('1', 1)).toEqual([notice(limited, 'rate_limit')])
    expect(await s.settled('3', 1)).toEqual([notice()])
    expect(s.texts('1')).toEqual([notice(limited, 'rate_limit')])
    expect(notice().split('\n')).toEqual(['⚠️ Claude\'s turn ended on an error.', 'Type: unknown', CREDITS, 'You will get a message here when a turn ends without an error.'])
    await s.channel.close()
  }, 30000)

  test('sends nothing more for the run\'s next failures, and back to normal once at the next clean turn', async () => {
    const s = await failing()
    s.recorded(upTo(own, 13), 12)
    expect(s.fail()).toEqual([0, 0])
    expect(await s.arrived('1', 1)).toEqual([notice()])
    s.write(prompt('p2', Date.now() - 500, '1', 2), apiError('e2', Date.now() - 50, CREDITS))
    expect(s.fail()).toEqual([0, 0])
    await wait(NOTHING_MS)
    expect(s.texts('1')).toEqual([notice()])
    s.write(prompt('p3', Date.now() - 500, '1', 3), reply('r3', Date.now() - 50, 'OK-later'))
    expect(s.stop('OK-later')).toEqual([0])
    expect(await s.arrived('1', 2)).toEqual([notice(), RESTORED_TEXT])
    await wait(NOTHING_MS)
    expect(s.texts('1')).toEqual([notice(), RESTORED_TEXT])
    await s.channel.close()
  }, 60000)

  test('a subagent\'s or a helper\'s StopFailure sends nothing, though it carries the turn\'s own error text; then the chat\'s own failure sends one notice', async () => {
    const s = await failing()
    // Out of credits, the subagent and the helper fail with the text of the
    // main turn's own error entry, just written.
    s.recorded(upTo(own, 13), 12)
    const same = { error: 'unknown', last_assistant_message: CREDITS, transcript_path: s.transcript }
    expect(s.hook('StopFailure', { ...failureHooks.subagent_stop_failure, ...same })).toEqual([0, 0])
    expect(s.hook('StopFailure', { ...turnHooks.helper_stop_failure, ...same })).toEqual([0, 0])
    await wait(NOTHING_MS)
    expect(s.sent()).toEqual([])
    // Chat 1's next turn fails, and its own StopFailure comes.
    s.write(prompt('p2', Date.now() - 500, '1', 2), apiError('e2', Date.now() - 50, CREDITS))
    expect(s.fail()).toEqual([0, 0])
    expect(await s.settled('1', 1)).toEqual([notice()])
    await s.channel.close()
  }, 60000)

  test('a turn no Telegram message started sends nothing: a scheduled task\'s, a task notification\'s, and the clean turn after them', async () => {
    const s = await failing()
    s.recorded(recorded('scheduled-start'), 46)
    expect(s.fail()).toEqual([0, 0])
    s.next().recorded(upTo(recorded('typed-and-task-turns'), 52), 52, 500)
    s.write(apiError('e-task', Date.now() - 50, CREDITS))
    expect(s.fail()).toEqual([0, 0])
    await wait(NOTHING_MS)
    expect(s.sent()).toEqual([])
    // Both records were attributed, to nobody, rather than left waiting for
    // an entry: the newest is the last the server finished, and the run told
    // no chat.
    expect(s.records().map(r => r.t)).toHaveLength(2)
    expect(s.run().seen).toBe(s.records()[1]!.t)
    expect(s.run().run!.notified).toEqual([])
    s.write(prompt('p1', Date.now() - 500, '1', 5), reply('r1', Date.now() - 50, 'OK-later'))
    expect(s.stop('OK-later')).toEqual([0])
    await wait(NOTHING_MS)
    expect(s.sent()).toEqual([])
    // The clean turn closed the run.
    expect(s.run().run).toBeNull()
    await s.channel.close()
  }, 40000)

  test('another bot\'s message: the notice and back to normal go to the owner chat, and nothing to the bot', async () => {
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1', '2'] })
    const bot = { id: 2, is_bot: true, first_name: 'Peer', username: 'peer_two_bot' }
    deliver(dir, [{ message: { message_id: 1, date: Math.floor(Date.now() / 1000), from: bot, chat: { id: 2, type: 'private' }, text: 'from the other bot' } }])
    const s = await failing({}, dir)
    await until(() => s.channel.inbound().length === 1, 6000)
    // Chat 2's own turn fails, at line 31.
    s.recorded(upTo(recorded('queued-behind-failing'), 32), 31)
    expect(s.fail()).toEqual([0, 0])
    expect(await s.arrived('1', 1)).toEqual([notice()])
    s.write(prompt('p3', Date.now() - 500, '2', 3), reply('r3', Date.now() - 50, 'OK-later'))
    expect(s.stop('OK-later')).toEqual([0])
    expect(await s.settled('1', 2)).toEqual([notice(), RESTORED_TEXT])
    expect(s.sent().filter(c => c.payload.chat_id !== '1')).toEqual([])
    await s.channel.close()
  }, 40000)

  test('a failure and a clean end inside one tick: the notice, then back to normal, though the notice reaches Telegram late', async () => {
    const s = await failing({ TELEGRAM_TEST_RULES: JSON.stringify([{ method: 'sendMessage', has: 'turn ended on an error', preMs: 1500 }]) })
    s.recorded(upTo(own, 13), 12)
    expect(s.fail()).toEqual([0, 0])
    s.write(prompt('p2', Date.now(), '1', 2), reply('r2', Date.now() + 10, 'OK-later'))
    await wait(30)
    expect(s.stop('OK-later')).toEqual([0])
    expect(await s.settled('1', 2)).toEqual([notice(), RESTORED_TEXT])
    await s.channel.close()
  }, 30000)
})
