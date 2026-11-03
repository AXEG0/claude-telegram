// The call record on a running server, on the fake Telegram. Every
// integration test already checks each call's line against what the fake
// answered (fixtures/call-log.ts, run at cleanup); these cases cover what that
// check cannot see: that no text reaches a line, that a record that cannot be
// written changes nothing else, and a start-up call answered after its
// deadline.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import fixture from './fixtures/channel-argv.json'
import { calls, cleanup, driveClock, start, state, until, wait } from './fixtures/harness.ts'

beforeEach(driveClock)
afterEach(cleanup)
const MARK = 'MARKER-q7Zt'
// The line a polling server prints once polling starts.
const POLLING = 'polling as '

describe.skipIf(process.platform !== 'linux')('the call record', () => {
  test('a reply whose text and file name hold markers, refused with a 400 that quotes one, leaves no marker in any call file', async () => {
    const dir = state()
    mkdirSync(join(dir, 'inbox'))
    writeFileSync(join(dir, 'inbox', `${MARK}.txt`), MARK)
    const refusal = { error_code: 400, description: `Bad Request: can't parse entities: Unsupported start tag "${MARK}" at byte offset 0` }
    const channel = start(dir, fixture.argv, { TELEGRAM_TEST_RULES: JSON.stringify([{ method: ['sendMessage', 'sendDocument'], error: refusal }]) })
    await channel.ready()
    await until(() => channel.stderr().includes(POLLING), 6000)
    await channel.request('tools/call', { name: 'reply', arguments: { chat_id: '1', text: `<${MARK}> hello`, files: [join(dir, 'inbox', `${MARK}.txt`)] } })
    await channel.close()
    const files = readdirSync(join(dir, 'logs')).filter(n => n.startsWith('calls-'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) expect(readFileSync(join(dir, 'logs', f), 'utf8')).not.toContain(MARK)
    expect(calls(dir).some(c => c.refused?.includes(MARK))).toBe(true)
  }, 20000)

  test('with a file where the logs folder goes, a reply still reaches Telegram, tools are served, and no call file exists', async () => {
    const dir = state()
    writeFileSync(join(dir, 'logs'), 'a regular file where the folder goes')
    const channel = start(dir, fixture.argv)
    await channel.ready()
    await until(() => channel.stderr().includes(POLLING), 6000)
    const r = (await channel.request('tools/call', { name: 'reply', arguments: { chat_id: '1', text: 'hello' } })).result
    expect(r.isError).toBeFalsy()
    expect(calls(dir).filter(c => c.method === 'sendMessage')).toHaveLength(1)
    expect((await channel.request('tools/list', {})).result.tools.length).toBeGreaterThan(0)
    expect(channel.exited()).toBe(false)
    await channel.close()
    expect(existsSync(join(dir, 'logs', `calls-${calls(dir)[0]!.pid}.jsonl`))).toBe(false)
  }, 20000)

  test('a getMe Telegram answers only after its 30 s deadline is asked again, and the server polls', async () => {
    const dir = state()
    const channel = start(dir, fixture.argv, { TELEGRAM_TEST_RULES: JSON.stringify([{ method: 'getMe', times: 1, holdMs: 31_000 }]) })
    await channel.ready()
    await until(() => channel.stderr().includes(POLLING), 60_000)
    expect(calls(dir).filter(c => c.method === 'getMe')).toHaveLength(2)
    // Past the held answer's own end, so the fake has given it too.
    await wait(2_000)
    await channel.close()
  }, 30000)
})
