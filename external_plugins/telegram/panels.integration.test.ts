// The record of each open subagents message, and the polling server closing
// the messages of a server that is gone, in the running server with the
// offline Telegram fake.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { AGENT_TICK_MS, CHAT_GAP_MS } from './agents.ts'
import { flock, LOCK_EX, LOCK_NB } from './buttons.ts'
import fixture from './fixtures/channel-argv.json'
import { calls, cleanup, conflicts, driveClock, start, state, until, wait, type Call } from './fixtures/harness.ts'
import { row, session, WAIT_MS } from './fixtures/session.ts'
import { toolCall } from './fixtures/transcript.ts'

beforeEach(driveClock)
afterEach(cleanup)

type Stored = { file: string; chat: string; message: number; text: string; writer: string }
const panelsDir = (dir: string) => join(dir, 'panels')
const records = (dir: string): Stored[] => {
  let names: string[] = []
  try { names = readdirSync(panelsDir(dir)) } catch {}
  return names.filter(n => n.endsWith('.json')).map(n => {
    const file = join(panelsDir(dir), n)
    return { file, ...JSON.parse(readFileSync(file, 'utf8')) }
  })
}
const lockFile = (dir: string, writer: string) => join(panelsDir(dir), `${writer}.lock`)
const edits = (dir: string, message: number) => calls(dir).filter(c => c.method === 'editMessageText' && c.payload.message_id === message)

// A record a test writes for a writer of its own.
const W = (n: number) => `${'ab'.repeat(7)}${String(n).padStart(2, '0')}`
function plant(dir: string, writer: string, message: number, text: string, opts: { lock?: boolean } = {}): string {
  mkdirSync(panelsDir(dir), { recursive: true })
  const file = join(panelsDir(dir), `1-${message}.json`)
  writeFileSync(file, JSON.stringify({ chat: '1', message, text, writer }))
  if (opts.lock) writeFileSync(lockFile(dir, writer), '')
  return file
}
// The test process holds a writer's lock, as a live writer does.
function hold(dir: string, writer: string): () => void {
  mkdirSync(panelsDir(dir), { recursive: true })
  const fd = openSync(lockFile(dir, writer), 'a')
  expect(flock()!(fd, LOCK_EX | LOCK_NB)).toBe(0)
  return () => closeSync(fd)
}

const RUNNING = /^🤖 Subagents\n1\. 🔌 No longer followed after \d+s · general-purpose · Long job · last: Starting…$/
// A second polling server on the same state folder.
async function nextServer(dir: string, env: Record<string, string> = {}) {
  const next = start(dir, fixture.argv, env)
  await next.ready()
  return next
}
const swept = async (dir: string, rec: { message: number; text: string }, pid?: number): Promise<Call> => {
  let found: Call | undefined
  // Records in one chat go one per slot, and a tick can land a little early.
  await until(() => !!(found = edits(dir, rec.message).find(c => c.payload.text === rec.text && (pid === undefined || c.pid !== pid))), 4 * AGENT_TICK_MS + 2000)
  return found!
}

describe.skipIf(process.platform !== 'linux')('the records of open subagents messages', () => {
  test('a server killed with SIGKILL while a row runs leaves its record, and the next polling server edits the message to the stored text and deletes it', async () => {
    const s = await session()
    s.begin('a1', 'Long job')
    const sent = await s.next(t => row(t, 1).startsWith('1. ⏳'))
    await until(() => records(s.dir).length === 1)
    const [rec] = records(s.dir)
    expect(rec).toMatchObject({ chat: '1', message: sent.message_id })
    expect(rec!.text).toMatch(RUNNING)
    expect(existsSync(lockFile(s.dir, rec!.writer))).toBe(true)
    const pid = s.channel.serverPid()
    process.kill(pid, 'SIGKILL')
    await until(() => s.channel.exited())
    await nextServer(s.dir)
    const edit = await swept(s.dir, rec!, pid)
    expect(edit.payload.chat_id).toBe('1')
    await until(() => !existsSync(rec!.file) && !existsSync(lockFile(s.dir, rec!.writer)))
  }, 30000)

  for (const [name, error] of [
    ['a 429', { error_code: 429, description: 'Too Many Requests: retry after 5', parameters: { retry_after: 5 } }],
    ['a 5xx', { error_code: 502, description: 'Bad Gateway' }],
  ] as const) {
    test(`a closing edit answered with ${name} leaves the record, and the next polling server closes the message`, async () => {
      const s = await session(conflicts([{ method: 'editMessageText', has: '🔌', error }]))
      s.begin('a1', 'Long job')
      const sent = await s.next(t => row(t, 1).startsWith('1. ⏳'))
      await s.channel.close()
      expect(calls(s.dir).filter(c => c.method === 'editMessageText' && c.refused)).toHaveLength(1)
      const [rec] = records(s.dir)
      expect(rec).toMatchObject({ chat: '1', message: sent.message_id })
      expect(rec!.text).toMatch(RUNNING)
      await nextServer(s.dir)
      await swept(s.dir, rec!, calls(s.dir)[0]!.pid)
      await until(() => !existsSync(rec!.file) && !existsSync(lockFile(s.dir, rec!.writer)))
    }, 30000)
  }

  test('a message that went gone keeps its record, with the rows it saw finish, while a later message writes its own, and the next server closes both', async () => {
    const s = await session({
      ...conflicts([{ method: 'editMessageText', has: '"message_id":7,', error: { error_code: 400, description: 'Bad Request: message thread not found' } }]),
      TELEGRAM_TEST_CHATS: JSON.stringify({ ids: 7 }),
    })
    s.begin('a1', 'Long job')
    const first = await s.next(t => row(t, 1).startsWith('1. ⏳'))
    expect(first.message_id).toBe(7)
    s.write('a1', toolCall('c1', Date.now(), 'Checking gate', 900))
    // Five refused edits in a row and the message is gone.
    await until(() => edits(s.dir, 7).filter(c => c.refused).length === 5, 7 * AGENT_TICK_MS)
    s.stop('a1')
    const goneFile = join(panelsDir(s.dir), '1-7.json')
    await until(() => existsSync(goneFile) && JSON.parse(readFileSync(goneFile, 'utf8')).text.includes('✅ Done'), WAIT_MS)
    s.begin('a2', 'Later job')
    const later = await s.next(t => t.includes('Later job'), first.index + 1)
    expect(later.method).toBe('sendMessage')
    expect(later.message_id).toBe(8)
    await until(() => records(s.dir).length === 2)
    const byMessage = new Map(records(s.dir).map(r => [r.message, r]))
    expect(byMessage.get(7)!.text).toMatch(/^🤖 Subagents\n1\. ✅ Done in \d+s · general-purpose · Long job · 900 tokens$/)
    expect(byMessage.get(8)!.text).toMatch(/^🤖 Subagents\n1\. 🔌 No longer followed after \d+s · general-purpose · Later job · last: Starting…$/)
    const pid = s.channel.serverPid()
    process.kill(pid, 'SIGKILL')
    await until(() => s.channel.exited())
    await nextServer(s.dir)
    await swept(s.dir, byMessage.get(7)!, pid)
    await swept(s.dir, byMessage.get(8)!, pid)
    await until(() => records(s.dir).length === 0)
  }, 60000)

  test('an edit Telegram applied whose answer was lost leaves a record holding that frame\'s closing text, and the row finished in it keeps its finished line', async () => {
    const s = await session(conflicts([{ method: 'editMessageText', has: '2. ✅ Done', times: 1, drop: true }]))
    s.begin('a1', 'Long job')
    s.begin('a2', 'Short job')
    const sent = await s.next(t => row(t, 2).startsWith('2. ⏳'))
    s.stop('a2')
    await s.next(t => row(t, 2).startsWith('2. ✅'), sent.index + 1)
    const pid = s.channel.serverPid()
    process.kill(pid, 'SIGKILL')
    await until(() => s.channel.exited())
    const [rec] = records(s.dir)
    expect(rec!.text).toMatch(/^🤖 Subagents\n1\. 🔌 No longer followed after \d+s · general-purpose · Long job · last: Starting…\n2\. ✅ Done in \d+s · general-purpose · Short job$/)
    await nextServer(s.dir)
    await swept(s.dir, rec!, pid)
  }, 30000)

  test('the close rewrites the record of a message whose closing edit does not go out', async () => {
    // A 429 holds the chat past the exit's time limit.
    const s = await session(conflicts([{ method: 'editMessageText', times: 1,
      error: { error_code: 429, description: 'Too Many Requests: retry after 20', parameters: { retry_after: 20 } } }]))
    s.begin('a1', 'Long job')
    s.begin('a2', 'Short job')
    await s.next(t => row(t, 2).startsWith('2. ⏳'))
    s.write('a1', toolCall('c1', Date.now(), 'Checking gate', 900))
    await until(() => calls(s.dir).some(c => c.method === 'editMessageText' && c.refused), WAIT_MS)
    s.stop('a2')
    await s.channel.close()
    expect(calls(s.dir).filter(c => c.method === 'editMessageText' && !c.refused)).toEqual([])
    const [rec] = records(s.dir)
    expect(rec!.text).toMatch(/^🤖 Subagents\n1\. 🔌 No longer followed after \d+s · general-purpose · Long job · last: Checking gate · 900 tokens\n2\. ✅ Done in \d+s · general-purpose · Short job$/)
  }, 30000)

  test('a first send answered during the close leaves the close-time text in its record', async () => {
    const s = await session(conflicts([
      { method: 'sendMessage', has: '🤖 Subagents', times: 1, holdMs: 1500 },
      { method: 'editMessageText', has: '🔌', error: { error_code: 429, description: 'Too Many Requests: retry after 5', parameters: { retry_after: 5 } } },
    ]))
    s.begin('a1', 'Long job')
    s.begin('a2', 'Short job')
    await s.next(t => row(t, 2).startsWith('2. ⏳'))
    s.stop('a2')
    await s.channel.close()
    const [rec] = records(s.dir)
    expect(rec!.text).toMatch(/^🤖 Subagents\n1\. 🔌 No longer followed after \d+s · general-purpose · Long job · last: Starting…\n2\. ✅ Done in \d+s · general-purpose · Short job$/)
  }, 30000)

  test('a replaced message\'s record is deleted, and the new message writes its own', async () => {
    const s = await session({
      ...conflicts([{ method: 'editMessageText', times: 1, error: { error_code: 400, description: 'Bad Request: message to edit not found' } }]),
      TELEGRAM_TEST_CHATS: JSON.stringify({ ids: 7 }),
    })
    s.begin('a1', 'Long job')
    const first = await s.next(t => row(t, 1).startsWith('1. ⏳'))
    await until(() => records(s.dir).some(r => r.message === 7))
    s.write('a1', toolCall('c1', Date.now(), 'Checking gate', 900))
    const second = await s.next(t => row(t, 1).includes('Checking gate') , first.index + 1)
    const replacement = await s.next(() => true, second.index + 1)
    expect(replacement.method).toBe('sendMessage')
    expect(replacement.message_id).toBe(8)
    await until(() => records(s.dir).some(r => r.message === 8))
    expect(records(s.dir).map(r => r.message)).toEqual([8])
  }, 30000)

  test('after a clean exit whose closing edit was accepted, the record is gone and the lock file stays, and the next polling server\'s sweep deletes it', async () => {
    const s = await session()
    s.begin('a1', 'Long job')
    await s.next(t => row(t, 1).startsWith('1. ⏳'))
    await until(() => records(s.dir).length === 1)
    const [rec] = records(s.dir)
    await s.channel.close()
    expect(s.panels().at(-1)!.payload.text).toMatch(RUNNING)
    expect(existsSync(rec!.file)).toBe(false)
    expect(existsSync(lockFile(s.dir, rec!.writer))).toBe(true)
    await nextServer(s.dir)
    await until(() => !existsSync(lockFile(s.dir, rec!.writer)), WAIT_MS)
  }, 30000)
})

describe.skipIf(process.platform !== 'linux')('the polling server\'s sweep', () => {
  test('a record whose writer still holds its lock stays, and one whose writer died is closed and deleted with its lock file', async () => {
    const dir = state()
    const release = hold(dir, W(1))
    const live = plant(dir, W(1), 201, '🤖 Subagents\n1. 🔌 live writer')
    const dead = plant(dir, W(2), 202, '🤖 Subagents\n1. 🔌 dead writer', { lock: true })
    await nextServer(dir)
    await swept(dir, { message: 202, text: '🤖 Subagents\n1. 🔌 dead writer' })
    await until(() => !existsSync(dead) && !existsSync(lockFile(dir, W(2))))
    await wait(AGENT_TICK_MS + 500)
    expect(existsSync(live)).toBe(true)
    expect(existsSync(lockFile(dir, W(1)))).toBe(true)
    expect(edits(dir, 201)).toEqual([])
    // Once the lock goes with its writer, the record is closed too.
    release()
    await swept(dir, { message: 201, text: '🤖 Subagents\n1. 🔌 live writer' })
    await until(() => !existsSync(live) && !existsSync(lockFile(dir, W(1))))
  }, 30000)

  test('a record whose writer has no lock file is closed, not dropped, and the try creates no lock file', async () => {
    const dir = state()
    const file = plant(dir, W(3), 301, '🤖 Subagents\n1. ✅ Done in 5s · general-purpose')
    await nextServer(dir, conflicts([{ method: 'editMessageText', has: '"message_id":301', holdMs: 1000 }]))
    await swept(dir, { message: 301, text: '🤖 Subagents\n1. ✅ Done in 5s · general-purpose' })
    // While Telegram holds its answer, the sweep has made no lock file.
    expect(readdirSync(panelsDir(dir)).filter(n => n.startsWith(W(3)))).toEqual([])
    await until(() => !existsSync(file))
    expect(readdirSync(panelsDir(dir)).filter(n => n.startsWith(W(3)))).toEqual([])
  }, 30000)

  test('a damaged record and a dead writer\'s temporary file are deleted, and a live writer\'s temporary file stays', async () => {
    const dir = state()
    mkdirSync(panelsDir(dir), { recursive: true })
    const damaged = join(panelsDir(dir), '1-401.json')
    writeFileSync(damaged, '{"chat":"1","mess')
    const deadTmp = join(panelsDir(dir), `1-402.json.${W(4)}.tmp`)
    writeFileSync(deadTmp, '{}')
    writeFileSync(lockFile(dir, W(4)), '')
    const release = hold(dir, W(5))
    const liveTmp = join(panelsDir(dir), `1-403.json.${W(5)}.tmp`)
    writeFileSync(liveTmp, '{}')
    await nextServer(dir)
    await until(() => !existsSync(damaged) && !existsSync(deadTmp) && !existsSync(lockFile(dir, W(4))), WAIT_MS)
    expect(existsSync(liveTmp)).toBe(true)
    expect(calls(dir).filter(c => c.method === 'editMessageText')).toEqual([])
    release()
  }, 30000)

  test('a record kept after a 429 is closed on a later tick, and its lock file is deleted only after', async () => {
    const dir = state()
    const text = '🤖 Subagents\n1. 🔌 retried'
    const file = plant(dir, W(6), 501, text, { lock: true })
    await nextServer(dir, conflicts([{ method: 'editMessageText', times: 1,
      error: { error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } } }]))
    await until(() => edits(dir, 501).some(c => c.refused), WAIT_MS)
    await wait(200)
    expect(existsSync(file)).toBe(true)
    expect(existsSync(lockFile(dir, W(6)))).toBe(true)
    await until(() => edits(dir, 501).some(c => !c.refused), WAIT_MS)
    await until(() => !existsSync(file) && !existsSync(lockFile(dir, W(6))))
  }, 30000)

  test('a swept edit and the live message\'s sends and edits in one chat stay the chat\'s spacing apart', async () => {
    const s = await session()
    const dir = s.dir
    s.begin('a1', 'Long job')
    await s.next(t => row(t, 1).startsWith('1. ⏳'))
    // A server that died left a record in the same chat, after the live
    // message went out; the live message wants an edit on each tick.
    plant(dir, W(7), 601, '🤖 Subagents\n1. 🔌 swept', { lock: true })
    // A tool call each second, on the test's clock.
    let step = 0
    let stepping = true
    const steps = (async () => {
      while (stepping) {
        await wait(1000)
        if (stepping) s.write('a1', toolCall(`c${++step}`, Date.now(), `Step ${step}`, 100 + step))
      }
    })()
    try {
      await until(() => edits(dir, 601).length === 1, 4 * AGENT_TICK_MS)
      const sweptAt = edits(dir, 601)[0]!.at
      await until(() => s.panels().some(c => c.at > sweptAt && c.payload.message_id !== 601), 4 * AGENT_TICK_MS)
    } finally {
      stepping = false
      await steps
    }
    const chat = calls(dir).filter(c => (c.method === 'sendMessage' || c.method === 'editMessageText') && c.payload.chat_id === '1')
    expect(chat.length).toBeGreaterThan(2)
    const gaps = chat.slice(1).map((c, i) => c.at - chat[i]!.at)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(CHAT_GAP_MS - 50)
  }, 30000)

  test('a waiter blocked on a dead writer\'s lock, granted once the sweep closed the last record, finds the lock file deleted', async () => {
    const dir = state()
    plant(dir, W(8), 701, '🤖 Subagents\n1. 🔌 waited on', { lock: true })
    await nextServer(dir, conflicts([{ method: 'editMessageText', has: '"message_id":701', holdMs: 1500 }]))
    await until(() => edits(dir, 701).length === 1, WAIT_MS)
    // The sweep holds the lock while Telegram holds its answer.
    const waiter = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', 'lock-waiter.ts'), lockFile(dir, W(8))], { stdout: 'pipe' })
    // The sweep lets go once its held answer comes, on the test's clock.
    let out: string | undefined
    void new Response(waiter.stdout).text().then(text => { out = text })
    await until(() => out !== undefined, 5000).catch(() => {})
    waiter.kill()
    expect(JSON.parse(out ?? '"timed out"')).toEqual({ granted: true, exists: false })
  }, 30000)
})
