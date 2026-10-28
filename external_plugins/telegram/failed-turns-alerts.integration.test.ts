// The failure notice beside the stuck notice and the idle alert, in the
// running server with the offline Telegram fake: a chat whose turn failed
// hears of the failure, and back to normal once turns end without an error,
// instead of "Claude is active again".
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { idleText, RECOVERED_TEXT, stuckText } from './alerts.ts'
import { failing, notice, NOTHING_MS, QUIET_MS, RESTORED_TEXT } from './fixtures/failing.ts'
import { cleanup, deliver, driveClock, state, until, wait } from './fixtures/harness.ts'
import { apiError, CREDITS, prompt, recorded, reply, upTo } from './fixtures/turns.ts'

beforeEach(driveClock)
afterEach(cleanup)

const own = recorded('start-absorbed-own-turns')
const STUCK = { TELEGRAM_STUCK_MINUTES: '0.01' }
const fromOwner = (dir: string, text: string) => deliver(dir, [{
  message: { message_id: 1, date: Math.floor(Date.now() / 1000), text, from: { id: 1, is_bot: false, first_name: 'Owner' }, chat: { id: 1, type: 'private' } },
}])
// A subagent's tool call: activity that brings the recovery, and starts no
// typing that a short stuck time would cap again.
const busy = { session_id: 'sess-1', agent_id: 'a1', agent_type: 'general-purpose', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: {} }

describe.skipIf(process.platform !== 'linux')('the failure notice and the stuck and idle alerts', () => {
  test('a turn that is stuck, then fails: the stuck notice, the failure notice instead of the recovery, then back to normal', async () => {
    const dir = state()
    fromOwner(dir, 'stuck, then failing')
    const s = await failing(STUCK, dir)
    expect(await s.arrived('1', 1)).toEqual([stuckText(600)])
    s.recorded(upTo(own, 13), 12)
    expect(s.fail()).toEqual([0, 0])
    expect(await s.arrived('1', 2)).toEqual([stuckText(600), notice()])
    await wait(QUIET_MS)
    s.write(prompt('p2', Date.now() - 500, '1', 2), reply('r2', Date.now() - 50, 'OK-later'))
    expect(s.stop('OK-later')).toEqual([0])
    expect(await s.settled('1', 3)).toEqual([stuckText(600), notice(), RESTORED_TEXT])
    await s.channel.close()
  }, 60000)

  test('a turn that is stuck, shows activity, then fails: the stuck notice and its recovery, then the failure notice and back to normal', async () => {
    const dir = state()
    fromOwner(dir, 'stuck, active, then failing')
    const s = await failing(STUCK, dir)
    expect(await s.arrived('1', 1)).toEqual([stuckText(600)])
    expect(s.hook('PostToolUse', busy)).toEqual([0])
    expect(await s.arrived('1', 2)).toEqual([stuckText(600), RECOVERED_TEXT])
    s.recorded(upTo(own, 13), 12)
    expect(s.fail()).toEqual([0, 0])
    expect(await s.arrived('1', 3)).toEqual([stuckText(600), RECOVERED_TEXT, notice()])
    s.write(prompt('p2', Date.now() - 500, '1', 2), reply('r2', Date.now() - 50, 'OK-later'))
    expect(s.stop('OK-later')).toEqual([0])
    expect(await s.settled('1', 4)).toEqual([stuckText(600), RECOVERED_TEXT, notice(), RESTORED_TEXT])
    await s.channel.close()
  }, 60000)

  test('a failure nobody was told of, then another turn stuck and active: the stuck notice and its recovery', async () => {
    const s = await failing(STUCK)
    s.recorded(recorded('scheduled-start'), 46)
    expect(s.fail()).toEqual([0, 0])
    await wait(NOTHING_MS)
    expect(s.sent()).toEqual([])
    fromOwner(s.dir, 'stuck after a silent failure')
    expect(await s.arrived('1', 1)).toEqual([stuckText(600)])
    expect(s.hook('PostToolUse', busy)).toEqual([0])
    expect(await s.settled('1', 2)).toEqual([stuckText(600), RECOVERED_TEXT])
    await s.channel.close()
  }, 60000)

  test('a transcript that lags: the error entry lands two ticks after the record, the notice still comes, and the stuck recovery due meanwhile is dropped', async () => {
    const dir = state()
    fromOwner(dir, 'stuck, then failing late')
    const s = await failing(STUCK, dir)
    expect(await s.arrived('1', 1)).toEqual([stuckText(600)])
    // Chat 1's turn, without its error entry yet.
    const lines = upTo(own, 13)
    const entryAt = Date.now() - 50
    s.recorded(lines.slice(0, 11), 7, 200)
    expect(s.fail()).toEqual([0, 0])
    await wait(2 * 4000)
    expect(s.texts('1')).toEqual([stuckText(600)])
    // Claude Code stamps the entry before its hook runs, and writes it late.
    s.write(apiError('late', entryAt, CREDITS))
    expect(await s.settled('1', 2)).toEqual([stuckText(600), notice()])
    await s.channel.close()
  }, 60000)

  test('the idle alert, then a failed turn of the owner\'s: the failure notice instead of the idle recovery', async () => {
    // Long enough that the next idle alert, 15 s after the failure's turn end, comes after the checks.
    const s = await failing({ TELEGRAM_ALERT_IDLE_MINUTES: '0.25' })
    expect(await s.arrived('1', 1, 15_000 + 3 * 4000)).toEqual([idleText(15_000)])
    s.recorded(upTo(own, 13), 12)
    expect(s.fail()).toEqual([0, 0])
    expect(await s.settled('1', 2)).toEqual([idleText(15_000), notice()])
    await s.channel.close()
  }, 60000)
})
