import { afterEach, describe, expect, test } from 'bun:test'
import { asSeconds, CONFLICT, cleanup, conflicts, deliver, pollGaps, start, state, until } from './fixtures/harness.ts'
import fixture from './fixtures/channel-argv.json'

afterEach(cleanup)

// The longest wait in the suite, alone in its file so that a run with
// --parallel gives it a worker of its own while the other files run beside it.
// Real /proc ancestry, real MCP transport, and the production server. Only
// grammy's HTTP transport is fake; this test never uses the owner's bot.
describe.skipIf(process.platform !== 'linux')('polling ownership in the running server', () => {
  test('through sixteen conflicts in a row the server waits 1 to 15 seconds between polls and then 15 again, keeps polling, and hears a message sent after the conflict ends', async () => {
    const dir = state()
    const channel = start(dir, fixture.argv, conflicts([{ method: 'getUpdates', times: 16, error: CONFLICT }]))
    await channel.ready()
    const waits = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 15]
    await until(() => pollGaps(dir).length > waits.length, 160_000)
    expect(asSeconds(pollGaps(dir).slice(0, waits.length), waits, 500)).toEqual(waits)
    deliver(dir, [{ message: { message_id: 10, date: Math.floor(Date.now() / 1000), from: { id: 1, is_bot: false, first_name: 'Owner' }, chat: { id: 1, type: 'private' }, text: 'after the conflict' } }])
    await until(() => channel.inbound().length === 1, 5000)
    expect(channel.inbound()[0]!.content).toBe('after the conflict')
    await channel.close()
  }, 180_000)
})
