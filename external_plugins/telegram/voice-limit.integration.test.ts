// A download held past the limit, in the running server, with long polls: in
// a file of its own, so the parallel runner gives its five minutes of the
// test's clock a worker of their own. Only Telegram's HTTP, its file host and
// the transcription endpoint are fake.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fixture from './fixtures/channel-argv.json'
import { calls, cleanup, deliver, driveClock, start, state, until, wait } from './fixtures/harness.ts'
import { FILE_LIMIT_MS } from './stt.ts'

beforeEach(driveClock)
afterEach(cleanup)

const OWNER = { id: 1, is_bot: false, first_name: 'Owner', username: 'owner' }
const DM = { id: 1, type: 'private' }
const seconds = () => Math.floor(Date.now() / 1000)

describe.skipIf(process.platform !== 'linux')('the limit on a message\'s file work', () => {
  test('I9 a download held past the limit sends the note on at 300 s with the reason, then the text sent after it', async () => {
    const dir = state()
    const channel = start(dir, fixture.argv, {
      TELEGRAM_TEST_LONG_POLL: '1',
      TELEGRAM_STT_OPENAI_KEY: 'test-key',
      TELEGRAM_TEST_FILES: JSON.stringify({ v1: { path: 'voice/file_1.oga', text: 'a long note' } }),
      TELEGRAM_TEST_RULES: JSON.stringify([{ method: 'download', holdMs: FILE_LIMIT_MS + 10_000 }]),
    })
    await channel.ready()
    deliver(dir, [{ update_id: 1, message: { message_id: 1, date: seconds(), from: OWNER, chat: DM,
      voice: { file_id: 'v1', file_unique_id: 'u-v1', duration: 600, mime_type: 'audio/ogg', file_size: 11 } } }])
    await until(() => calls(dir).some(c => c.method === 'download'), 4000)
    const t0 = Date.now()
    await wait(5000)
    deliver(dir, [{ update_id: 2, message: { message_id: 2, date: seconds(), from: OWNER, chat: DM, text: 'sent after the note' } }])
    await until(() => channel.inbound().length > 0, FILE_LIMIT_MS + 5000)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(FILE_LIMIT_MS - 1000)
    expect(Date.now() - t0).toBeLessThan(FILE_LIMIT_MS + 1000)
    await until(() => channel.inbound().length === 2, 4000)
    const [note, after] = channel.inbound()
    expect(note.content).toBe('(voice message)')
    expect(note.meta.transcript_error).toBe('download gave no answer within 300 s')
    expect(after.content).toBe('sent after the note')
    await channel.close()
  }, 120000)
})
