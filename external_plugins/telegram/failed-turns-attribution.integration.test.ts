// Which chats a failed turn's notice goes to, read from the recorded session
// transcripts, in the running server with the offline Telegram fake.
import { afterEach, describe, expect, test } from 'bun:test'
import { CREDITS, failing, notice, NOTHING_MS, QUIET_MS, RESTORED_TEXT } from './fixtures/failing.ts'
import { cleanup } from './fixtures/harness.ts'
import { apiError, prompt, recorded, reply, upTo } from './fixtures/turns.ts'

afterEach(cleanup)

describe.skipIf(process.platform !== 'linux')('the chats a failed turn tells', () => {
  test('a message taken into chat 1\'s running turn gets no notice of its own; chat 1 gets one', async () => {
    const s = await failing()
    // Chat 1's second turn, from line 14 through the turn_duration line after its failure: chat 2's message comes in
    // at a tool call, then the turn fails at line 41.
    const lines = recorded('start-absorbed-own-turns')
    s.recorded(lines.slice(13, lines.findIndex((l, i) => i > 13 && l.subtype === 'turn_duration') + 1), 28)
    expect(s.fail()).toEqual([0, 0])
    expect(await s.settled('1', 1)).toEqual([notice()])
    expect(s.texts('2')).toEqual([])
    await s.channel.close()
  }, 40000)

  test('a message queued behind chat 1\'s clean turn runs as its own turn: its failure tells chat 3 alone', async () => {
    const s = await failing()
    s.recorded(recorded('queued-alone'), 33)
    expect(s.fail()).toEqual([0, 0])
    expect(await s.settled('3', 1)).toEqual([notice()])
    expect(s.texts('1')).toEqual([])
    await s.channel.close()
  }, 40000)

  test('two messages queued behind chat 1\'s clean turn run as one turn: its failure tells chats 2 and 3, and not chat 1', async () => {
    const s = await failing()
    s.recorded(upTo(recorded('merged-starts'), 33), 31)
    expect(s.fail()).toEqual([0, 0])
    expect(await s.arrived('2', 1)).toEqual([notice()])
    expect(await s.settled('3', 1)).toEqual([notice()])
    expect(s.texts('1')).toEqual([])
    await s.channel.close()
  }, 40000)

  test('a message taken into the clean turn before the failed one gets nothing', async () => {
    const s = await failing()
    s.recorded(upTo(recorded('absorbed-into-earlier-turn'), 34), 32)
    expect(s.fail()).toEqual([0, 0])
    expect(await s.arrived('2', 1)).toEqual([notice()])
    expect(await s.settled('3', 1)).toEqual([notice()])
    expect(s.texts('9')).toEqual([])
    expect(s.texts('1')).toEqual([])
    await s.channel.close()
  }, 40000)

  test('two failures 60 ms apart, from chats 1 and 3, both written before the first hook runs: each chat gets one notice', async () => {
    const s = await failing()
    s.recorded(recorded('two-close-failures'), 10, 20)
    expect(s.fail()).toEqual([0, 0])
    expect(s.fail()).toEqual([0, 0])
    expect(await s.arrived('1', 1)).toEqual([notice()])
    expect(await s.settled('3', 1)).toEqual([notice()])
    expect(s.texts('1')).toEqual([notice()])
    await s.channel.close()
  }, 40000)

  test('a clean turn\'s Stop hook that runs after the next turn\'s StopFailure hook brings no back to normal, and the next failure no second notice', async () => {
    const s = await failing()
    // Chat 1's turn ends clean with "OK-answer-1"; chats 2 and 3's queued turn fails.
    s.recorded(upTo(recorded('merged-starts'), 33), 31)
    expect(s.fail()).toEqual([0, 0])
    // Chat 1's Stop hook, late.
    expect(s.stop('OK-answer-1')).toEqual([0])
    expect(await s.arrived('2', 1)).toEqual([notice()])
    // Chat 2's next turn fails too.
    s.write(prompt('p2', Date.now() - 500, '2', 3), apiError('e2', Date.now() - 50, CREDITS))
    expect(s.fail()).toEqual([0, 0])
    await Bun.sleep(NOTHING_MS)
    expect(s.texts('2')).toEqual([notice()])
    expect(s.texts('3')).toEqual([notice()])
    // A clean turn of chat 2's.
    s.write(prompt('p3', Date.now() - 500, '2', 4), reply('r3', Date.now() - 50, 'OK-later'))
    expect(s.stop('OK-later')).toEqual([0])
    expect(await s.arrived('2', 2)).toEqual([notice(), RESTORED_TEXT])
    expect(await s.settled('3', 2)).toEqual([notice(), RESTORED_TEXT])
    await Bun.sleep(QUIET_MS)
    expect(s.texts('2')).toEqual([notice(), RESTORED_TEXT])
    await s.channel.close()
  }, 60000)
})
