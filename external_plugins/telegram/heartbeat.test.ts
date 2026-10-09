import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Bot, GrammyError } from 'grammy'
import { heartbeatTransformer, writeHeartbeat } from './heartbeat.ts'

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'tg-heartbeat-'))
}

// A real grammy Bot whose HTTP calls return the given Bot API bodies in turn,
// so the transformer runs inside grammy's own call path.
function botAnswering(bodies: object[]): Bot {
  const queue = [...bodies]
  const fakeFetch = (async () =>
    new Response(JSON.stringify(queue.shift() ?? { ok: true, result: [] }), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
  return new Bot('123:test-token', {
    botInfo: { id: 123, is_bot: true, first_name: 't', username: 't_bot' } as never,
    client: { fetch: fakeFetch },
  })
}

describe('poll heartbeat', () => {
  test('a completed getUpdates writes the pid and the time', async () => {
    const file = join(dir(), 'poll-heartbeat.json')
    const bot = botAnswering([{ ok: true, result: [] }])
    bot.api.config.use(heartbeatTransformer(file, 4242, () => 1_700_000_000_000))
    await bot.api.getUpdates({ timeout: 0 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pid: 4242, at: 1_700_000_000_000 })
  })

  test('each completed poll moves the time forward', async () => {
    const file = join(dir(), 'poll-heartbeat.json')
    let t = 1_000
    const bot = botAnswering([{ ok: true, result: [] }, { ok: true, result: [] }])
    bot.api.config.use(heartbeatTransformer(file, 7, () => t))
    await bot.api.getUpdates({ timeout: 0 })
    t = 31_000
    await bot.api.getUpdates({ timeout: 0 })
    expect(JSON.parse(readFileSync(file, 'utf8')).at).toBe(31_000)
  })

  test('a refused poll writes nothing and still reaches the poll loop as an error', async () => {
    const file = join(dir(), 'poll-heartbeat.json')
    const bot = botAnswering([{ ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' }])
    bot.api.config.use(heartbeatTransformer(file, 7))
    await expect(bot.api.getUpdates({ timeout: 0 })).rejects.toBeInstanceOf(GrammyError)
    expect(existsSync(file)).toBe(false)
  })

  test('a network failure writes nothing', async () => {
    const file = join(dir(), 'poll-heartbeat.json')
    const failing = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    const bot = new Bot('123:test-token', { client: { fetch: failing } })
    bot.api.config.use(heartbeatTransformer(file, 7))
    await expect(bot.api.getUpdates({ timeout: 0 })).rejects.toThrow()
    expect(existsSync(file)).toBe(false)
  })

  test('other methods write nothing', async () => {
    const file = join(dir(), 'poll-heartbeat.json')
    const bot = botAnswering([{ ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: 'private' } } }])
    bot.api.config.use(heartbeatTransformer(file, 7))
    await bot.api.sendMessage(1, 'hi')
    expect(existsSync(file)).toBe(false)
  })

  test('a failed write is reported and the poll still returns its updates', async () => {
    const errors: unknown[] = []
    const bot = botAnswering([{ ok: true, result: [{ update_id: 5 }] }])
    bot.api.config.use(heartbeatTransformer('/unused', 7, Date.now, () => { throw new Error('ENOSPC') }, e => errors.push(e)))
    const updates = await bot.api.getUpdates({ timeout: 0 })
    expect(updates).toEqual([{ update_id: 5 }] as never)
    expect(errors).toHaveLength(1)
  })

  test('the write replaces the file whole and leaves no temp file', () => {
    const d = dir()
    const file = join(d, 'poll-heartbeat.json')
    writeHeartbeat(file, 9, 1)
    writeHeartbeat(file, 9, 2)
    expect(readdirSync(d)).toEqual(['poll-heartbeat.json'])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pid: 9, at: 2 })
  })

  test('the server installs the heartbeat on its bot', () => {
    const server = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
    expect(server).toContain("const HEARTBEAT_FILE = join(STATE_DIR, 'poll-heartbeat.json')")
    expect(server).toMatch(/bot\.api\.config\.use\(heartbeatTransformer\(HEARTBEAT_FILE, process\.pid,/)
  })
})
