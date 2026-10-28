// The failure notice across a server restart, and a notice Telegram refuses,
// in the running server with the offline Telegram fake.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { CREDITS, failing, notice, NOTHING_MS, RESTORED_TEXT, session } from './fixtures/failing.ts'
import fixture from './fixtures/channel-argv.json'
import { calls, cleanup, deliver, driveClock, start, state, until, wait } from './fixtures/harness.ts'
import turnHooks from './fixtures/turn-hooks.json'
import { apiError, prompt, recorded, reply, upTo } from './fixtures/turns.ts'

beforeEach(driveClock)
afterEach(cleanup)

const own = recorded('start-absorbed-own-turns')

// A second server on the same state folder, as after a restart, carrying on
// the first one's transcript.
async function restart(first: ReturnType<typeof session>, env: Record<string, string> = {}) {
  const channel = start(first.dir, fixture.argv, { TELEGRAM_ALERT_CHAT: '1', ...env })
  await channel.ready()
  const s = session(first.dir, channel)
  s.transcript = first.transcript
  return s
}

describe.skipIf(process.platform !== 'linux')('the failure notice across a restart', () => {
  test('a new server sends no second notice for a told chat\'s next failure, and back to normal once', async () => {
    const first = await failing()
    first.recorded(upTo(own, 13), 12)
    expect(first.fail()).toEqual([0, 0])
    expect(await first.arrived('1', 1)).toEqual([notice()])
    await first.channel.close()
    const s = await restart(first)
    s.write(prompt('p2', Date.now() - 500, '1', 2), apiError('e2', Date.now() - 50, CREDITS))
    expect(s.fail()).toEqual([0, 0])
    await wait(NOTHING_MS)
    expect(s.texts('1')).toEqual([notice()])
    s.write(prompt('p3', Date.now() - 500, '1', 3), reply('r3', Date.now() - 50, 'OK-later'))
    expect(s.stop('OK-later')).toEqual([0])
    expect(await s.settled('1', 2)).toEqual([notice(), RESTORED_TEXT])
    await s.channel.close()
  }, 60000)

  test('a clean turn that ends while no server runs brings back to normal from the next server', async () => {
    const env = { CLAUDE_CODE_SESSION_ID: turnHooks.stop_after_402.session_id }
    const first = await failing(env)
    first.recorded(upTo(own, 13), 12)
    expect(first.fail()).toEqual([0, 0])
    expect(await first.arrived('1', 1)).toEqual([notice()])
    await first.channel.close()
    first.write(prompt('p3', Date.now() - 500, '1', 2), reply('r3', Date.now() - 50, 'OK-later'))
    expect(first.stop('OK-later')).toEqual([0])
    const s = await restart(first, env)
    expect(await s.settled('1', 2)).toEqual([notice(), RESTORED_TEXT])
    await s.channel.close()
  }, 60000)

  test('a bot\'s message in the transcript, after a restart: Telegram says it is a bot, so only the owner chat is told', async () => {
    const bot = { id: 2, is_bot: true, first_name: 'Peer', username: 'peer_two_bot' }
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1', '2'] })
    deliver(dir, [{ message: { message_id: 1, date: Math.floor(Date.now() / 1000), from: bot, chat: { id: 2, type: 'private' }, text: 'from the other bot' } }])
    const users = { TELEGRAM_TEST_USERS: JSON.stringify({ 2: bot }) }
    const first = await failing(users, dir)
    await until(() => first.channel.inbound().length === 1, 6000)
    await first.channel.close()
    // The new server has not heard the bot.
    const s = await restart(first, users)
    s.recorded(upTo(recorded('queued-behind-failing'), 32), 31)
    expect(s.fail()).toEqual([0, 0])
    expect(await s.settled('1', 1)).toEqual([notice()])
    expect(s.sent().filter(c => c.payload.chat_id !== '1')).toEqual([])
    expect(calls(dir).filter(c => c.method === 'getChatMember').map(c => c.payload.user_id)).toEqual([2])
    await s.channel.close()
  }, 60000)
})

describe.skipIf(process.platform !== 'linux')('a notice Telegram refuses', () => {
  const refuse = (after: number) => ({ TELEGRAM_TEST_RULES: JSON.stringify([{
    method: 'sendMessage', has: 'turn ended on an error', times: 1,
    error: { error_code: 429, description: `Too Many Requests: retry after ${after}`, parameters: { retry_after: after } },
  }]) })
  const refused = (dir: string) => calls(dir).filter(c => c.method === 'sendMessage' && c.refused)

  test('goes again once Telegram allows, and back to normal comes after it', async () => {
    const s = await failing(refuse(2))
    s.recorded(upTo(own, 13), 12)
    expect(s.fail()).toEqual([0, 0])
    expect(await s.arrived('1', 1)).toEqual([notice()])
    expect(refused(s.dir).length).toBe(1)
    expect(s.sent()[0]!.at - refused(s.dir)[0]!.at).toBeGreaterThanOrEqual(2000)
    s.write(prompt('p2', Date.now() - 500, '1', 2), reply('r2', Date.now() - 50, 'OK-later'))
    expect(s.stop('OK-later')).toEqual([0])
    expect(await s.settled('1', 2)).toEqual([notice(), RESTORED_TEXT])
    await s.channel.close()
  }, 40000)

  test('still waiting when the run closes, the notice keeps its retries, and back to normal follows it', async () => {
    const s = await failing(refuse(15))
    s.recorded(upTo(own, 13), 12)
    expect(s.fail()).toEqual([0, 0])
    await until(() => refused(s.dir).length === 1, 3 * 4000 + 2000)
    // The clean turn comes while the notice waits.
    s.write(prompt('p2', Date.now() - 500, '1', 2), reply('r2', Date.now() - 50, 'OK-later'))
    expect(s.stop('OK-later')).toEqual([0])
    expect(await s.settled('1', 2, 15_000 + 2 * 4000)).toEqual([notice(), RESTORED_TEXT])
    expect(s.sent()[0]!.at - refused(s.dir)[0]!.at).toBeGreaterThanOrEqual(15_000)
    await s.channel.close()
  }, 60000)
})
