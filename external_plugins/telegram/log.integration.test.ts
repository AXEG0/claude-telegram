// The server log on a running server: its lines before and after connect, a
// log that cannot be written, and the masking of the token and the key.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import fixture from './fixtures/channel-argv.json'
import { cleanup, deliver, driveClock, start, state, until } from './fixtures/harness.ts'

beforeEach(driveClock)
afterEach(cleanup)
const VERSION = JSON.parse(readFileSync(join(import.meta.dir, '.claude-plugin', 'plugin.json'), 'utf8')).version
const records = (dir: string, pid: number) => {
  try { return readFileSync(join(dir, 'logs', `server-${pid}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] }
}
const count = (text: string, part: string) => text.split(part).length - 1
// The line a polling server prints once polling starts, up to the bot's name.
const POLLING = 'telegram channel: polling as @'

describe.skipIf(process.platform !== 'linux')('the server log', () => {
  test('lines from before and after connect land once, with time, pid and version', async () => {
    const dir = state()
    const channel = start(dir, fixture.argv)
    await channel.ready()
    const pid = channel.serverPid()
    await until(() => records(dir, pid).some(r => r.log.includes(POLLING)), 6000)
    const recs = records(dir, pid)
    for (const part of ['TELEGRAM_ALERT_CHAT is not set', POLLING]) {
      const hit = recs.filter(r => r.log.includes(part))
      expect(hit).toHaveLength(1)
      expect(hit[0]).toMatchObject({ pid, version: VERSION })
      expect(Number.isNaN(Date.parse(hit[0].at))).toBe(false)
      expect(count(channel.stderr(), part)).toBe(1)
    }
    // Beside it, the call record of the same server (see flood.ts).
    expect(readdirSync(join(dir, 'logs')).sort()).toEqual([`calls-${pid}.jsonl`, `server-${pid}.jsonl`])
  }, 30000)

  test('a log that cannot be written changes nothing else', async () => {
    const dir = state()
    writeFileSync(join(dir, 'logs'), 'a regular file where the folder goes')
    const channel = start(dir, fixture.argv)
    await channel.ready()
    const tools = await channel.request('tools/list', {})
    expect(tools.result.tools.length).toBeGreaterThan(0)
    await until(() => channel.stderr().includes(POLLING), 6000)
    expect(channel.exited()).toBe(false)
  }, 30000)

  test('the token and the key from .env, and a token-shaped text, are masked in the file and on stderr', async () => {
    const dir = state()
    const TOKEN = 'abc:not-a-shaped-token-1234'
    const KEY = 'sk-test-masking-key-5678'
    const SHAPED = '1234567:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123'
    writeFileSync(join(dir, '.env'), `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_STT_OPENAI_KEY=${KEY}\n`)
    const FILES = { v1: { path: 'voice/file_1.oga', text: 'the first note' } }
    const channel = start(dir, fixture.argv, {
      TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_STT_OPENAI_KEY: undefined,
      TELEGRAM_TEST_FILES: JSON.stringify(FILES),
      TELEGRAM_TEST_RULES: JSON.stringify([
        { method: 'getMe', times: 1, error: { error_code: 401, description: `Unauthorized: ${TOKEN} and ${SHAPED}` } },
        { method: 'transcribe', error: { error_code: 401, description: 'Unauthorized' }, body: `bad key ${KEY}` },
      ]),
    } as unknown as Record<string, string>)
    await channel.ready()
    const pid = channel.serverPid()
    await until(() => channel.stderr().includes(POLLING), 8000)
    deliver(dir, [{ update_id: 1, message: { message_id: 101, date: Math.floor(Date.now() / 1000), from: { id: 1, is_bot: false, first_name: 'Owner' }, chat: { id: 1, type: 'private' },
      voice: { file_id: 'v1', file_unique_id: 'u-v1', duration: 3, mime_type: 'audio/ogg', file_size: 14 } } }])
    await until(() => channel.stderr().includes('speech to text failed'), 8000)
    const file = records(dir, pid).map(r => r.log).join('\n')
    for (const text of [file, channel.stderr()]) {
      for (const secret of [TOKEN, KEY, SHAPED]) expect(text).not.toContain(secret)
      expect(text).toContain(`polling error: GrammyError: Call to 'getMe' failed! (401: Unauthorized: <masked> and <masked>)`)
      expect(text).toContain('speech to text failed: transcription HTTP 401: bad key <masked>')
    }
  }, 30000)
})
