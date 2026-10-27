// What the running server does when it shuts down: with Claude Code gone, the
// order of its steps and its broken output must not cost an update or the
// closing edit. Only Telegram's HTTP is fake.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'fs'
import { join } from 'path'
import { CHAT_GAP_MS, CLOSING_EDIT_MS } from './agents.ts'
import fixture from './fixtures/channel-argv.json'
import { calls, cleanup, deliver, EXIT_MS, start, state, until } from './fixtures/harness.ts'
import { ownerWrites, row, session } from './fixtures/session.ts'

afterEach(cleanup)

const LONG_POLL = { TELEGRAM_TEST_LONG_POLL: '1' }
const longPoll = (dir: string, offset: number) =>
  calls(dir).some(c => c.method === 'getUpdates' && c.payload.timeout !== undefined && c.payload.offset === offset && !(c as { aborted?: boolean }).aborted)

describe.skipIf(process.platform !== 'linux')('the server\'s shutdown', () => {
  test('an update that arrives after shutdown starts is never confirmed, with Claude Code gone and a batch pending', async () => {
    const dir = state()
    ownerWrites(dir, 'waiting in its batch')
    const channel = start(dir, fixture.argv, LONG_POLL)
    await channel.ready()
    // The first update is taken, its text waits 300 ms in its batch, and the
    // next long poll is on its way.
    await until(() => longPoll(dir, 2), 6000)
    // Claude Code is gone: nobody reads the server's output, and its input ends.
    channel.child.stdout.destroy()
    channel.child.stdin.end()
    await Bun.sleep(500)
    deliver(dir, [{ update_id: 2, message: { message_id: 2, date: Math.floor(Date.now() / 1000), text: 'after shutdown',
      from: { id: 1, is_bot: false, first_name: 'Owner' }, chat: { id: 1, type: 'private' } } }])
    await until(() => channel.exited(), EXIT_MS)
    const polls = calls(dir).filter(c => c.method === 'getUpdates')
    expect(polls.filter(c => (c.payload.offset ?? 0) > 2)).toEqual([])
    // Telegram still holds the update for the next poller.
    expect(existsSync(join(dir, 'inbound.json'))).toBe(true)
    // The long poll that was on its way was aborted.
    expect(polls.some(c => (c as { aborted?: boolean }).aborted && c.payload.offset === 2)).toBe(true)
  }, 20000)

  test('with Claude Code alive, a text message still waiting in its batch at shutdown reaches Claude Code', async () => {
    const dir = state()
    ownerWrites(dir, 'waiting in its batch')
    const channel = start(dir, fixture.argv, LONG_POLL)
    await channel.ready()
    await until(() => longPoll(dir, 2), 6000)
    channel.child.stdin.end()
    await until(() => channel.exited(), EXIT_MS)
    expect(channel.inbound().map(n => n.content)).toEqual(['waiting in its batch'])
  }, 20000)

  test('the input ending with the output readers gone, as when Claude Code crashes, still gives one closing edit and an exit within the time limit', async () => {
    const s = await session()
    s.begin('a1', 'Long job')
    const sent = await s.next(t => row(t, 1).startsWith('1. ⏳'))
    const before = calls(s.dir).length
    s.channel.child.stdout.destroy()
    s.channel.child.stderr.destroy()
    const endedAt = Date.now()
    s.channel.child.stdin.end()
    await until(() => s.channel.exited(), CHAT_GAP_MS + CLOSING_EDIT_MS + 1000)
    expect(Date.now() - endedAt).toBeLessThanOrEqual(CHAT_GAP_MS + CLOSING_EDIT_MS + 500)
    const closing = calls(s.dir).slice(before).filter(c => c.method === 'editMessageText')
    expect(closing).toHaveLength(1)
    expect(closing[0]!.payload.message_id).toBe(sent.message_id)
    expect(closing[0]!.payload.text).toMatch(/^🤖 Subagents\n1\. 🔌 No longer followed after \d+s · general-purpose · Long job · last: Starting…$/)
  }, 20000)
})
