// The deadline on each poll in the running server (deadline.ts), on the fake
// Telegram and the driven clock: a poll Telegram never answers ends at 45 s
// and costs no update. Only Telegram's HTTP is fake.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import fixture from './fixtures/channel-argv.json'
import { calls, cleanup, deliver, driveClock, start, state, until, wait } from './fixtures/harness.ts'

beforeEach(driveClock)
afterEach(cleanup)

const OWNER = { id: 1, is_bot: false, first_name: 'Owner' }
const text = (update_id: number, words: string) => ({ update_id, message: {
  message_id: update_id, date: Math.floor(Date.now() / 1000), text: words, from: OWNER, chat: { id: 1, type: 'private' },
} })
const polls = (dir: string) => calls(dir).filter(c => c.method === 'getUpdates' && c.payload.timeout !== undefined && !c.aborted)
// The fake's line for a poll whose request was aborted, written at the abort.
const aborts = (dir: string) => calls(dir).filter(c => c.method === 'getUpdates' && c.aborted)
const heartbeat = (dir: string): number => JSON.parse(readFileSync(join(dir, 'poll-heartbeat.json'), 'utf8')).at
const failedPolls = (stderr: string) => stderr.split('\n').filter(line => line.includes('poll failed'))

describe.skipIf(process.platform !== 'linux')('the deadline on each poll', () => {
  test('a poll that never answers ends at 45 s, the next starts 3 s later from the same offset, no update is lost or handled twice, and each failed poll writes one log line', async () => {
    const dir = state()
    const channel = start(dir, fixture.argv, {
      TELEGRAM_TEST_LONG_POLL: '1',
      TELEGRAM_TEST_RULES: JSON.stringify([
        // The second poll gets no answer until 46.5 s, past its deadline; that
        // answer then brings the round the test wrote meanwhile, which stays
        // for the next poll, as an unconfirmed update does.
        { method: 'getUpdates', skip: 1, times: 1, holdMs: 46_500, keep: true },
        // The third never answers: it ends only when its request is aborted.
        { method: 'getUpdates', skip: 1, times: 1, hang: true },
        // The fourth fails at once, its connection reset.
        { method: 'getUpdates', skip: 1, times: 1, drop: true },
      ]),
    })
    await channel.ready()
    await until(() => polls(dir).length === 1, 6000)
    deliver(dir, [text(1, 'first')])
    await until(() => polls(dir).length === 2, 4000)
    const beat = heartbeat(dir)
    const hung = polls(dir)[1]!
    expect(hung.payload.offset).toBe(2)
    deliver(dir, [text(2, 'second')])
    // Past the hung poll's late answer, before the next poll.
    await wait(hung.at + 47_000 - Date.now())
    expect(polls(dir)).toHaveLength(2)
    expect(heartbeat(dir)).toBe(beat)
    expect(failedPolls(channel.stderr())).toEqual(['telegram channel: poll failed after 45.0 s: no answer within 45 s'])
    await until(() => polls(dir).length >= 6, 60_000)
    const [, , silent, reset, fifth, sixth] = polls(dir)
    // Each poll with no answer ends at 45 s, and the next comes after grammY's
    // 3 s wait, from the same offset; the reset poll fails at once and the
    // next comes 3 s later, still from that offset.
    expect(Math.abs(silent!.at - hung.at - 48_000)).toBeLessThanOrEqual(150)
    expect(aborts(dir).map(c => c.payload.offset)).toEqual([2])
    expect(Math.abs(aborts(dir)[0]!.at - silent!.at - 45_000)).toBeLessThanOrEqual(150)
    expect(Math.abs(reset!.at - silent!.at - 48_000)).toBeLessThanOrEqual(150)
    expect(Math.abs(fifth!.at - reset!.at - 3_000)).toBeLessThanOrEqual(150)
    expect([silent, reset, fifth].map(c => c!.payload.offset)).toEqual([2, 2, 2])
    expect(sixth!.payload.offset).toBe(3)
    expect(failedPolls(channel.stderr())).toEqual([
      'telegram channel: poll failed after 45.0 s: no answer within 45 s',
      'telegram channel: poll failed after 45.0 s: no answer within 45 s',
      'telegram channel: poll failed after 0.0 s: fetch failed: the connection was reset',
    ])
    expect(heartbeat(dir)).toBeGreaterThan(beat)
    await wait(1000)
    expect(channel.inbound().map(n => n.content)).toEqual(['first', 'second'])
    await channel.close()
  }, 120_000)
})
