// The live check (live-check.ts) run on the stand-in in both places: its
// Telegram is the stand-in too, loaded the way every test loads it, so each
// call it makes to Telegram lands in the stand-in's call log, and a rule
// (TELEGRAM_TEST_RULES) makes that Telegram answer a case otherwise.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CASES } from './live-check.ts'

// A token that reads plainly fake, with a colon as a real one has, so the
// check's masking of each of its parts shows.
const TOKEN = '4242:test-bot-token'
const PARTS = [TOKEN, '4242', 'test-bot-token']
const SENDS = ['sendMessage', 'sendDocument', 'sendMediaGroup']
// Each test runs the check, and the check the stand-in's run, two processes
// of their own each, which a busy machine can make slower than bun's 5 s.
const BOUND = 60_000
type Call = { method: string; payload: Record<string, any>; message_id?: number; message_ids?: number[]; refused?: string; failed?: string }

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

async function check(o: { token?: string; args?: string[]; rules?: object[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'live-check-test-'))
  dirs.push(dir)
  const log = join(dir, 'api.jsonl')
  const env: Record<string, string> = { PATH: process.env.PATH!, TMPDIR: tmpdir(), TELEGRAM_TEST_API_LOG: log, TELEGRAM_TEST_CHATS: JSON.stringify({ ids: 1 }) }
  if (process.env.HOME) env.HOME = process.env.HOME
  if (o.token !== undefined) env.TELEGRAM_LIVE_CHECK_TOKEN = o.token
  if (o.rules) env.TELEGRAM_TEST_RULES = JSON.stringify(o.rules)
  const p = Bun.spawn([process.execPath, '--preload', join(import.meta.dir, 'fixtures', 'telegram-preload.ts'),
    join(import.meta.dir, 'live-check.ts'), ...(o.args ?? ['--chat', '5', '--pace', '0'])], { env, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
  const code = await p.exited
  const calls: Call[] = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  return { code, out, err, calls, lines: out.split('\n').filter(Boolean) }
}

// The ids of the messages each send took, and the deletes: each message
// taken is deleted exactly once, and before the next send, so a case's
// messages are gone before the next case sends.
function deletes(calls: Call[]) {
  const pending = new Set<number>()
  const taken: number[] = [], deleted: number[] = []
  for (const c of calls) {
    if (SENDS.includes(c.method) && !c.refused && !c.failed) {
      expect({ before: c.method, pending: [...pending] }).toEqual({ before: c.method, pending: [] })
      const ids = c.message_ids ?? (c.message_id !== undefined ? [c.message_id] : [])
      for (const id of ids) { taken.push(id); pending.add(id) }
    }
    if (c.method === 'deleteMessage') { deleted.push(c.payload.message_id); pending.delete(c.payload.message_id) }
  }
  return { taken, deleted: [...deleted].sort((a, b) => a - b) }
}

test('without a token or a chat it refuses before any call', async () => {
  const none = await check()
  expect(none.code).toBe(2)
  expect(none.err).toContain("live-check: no token: set TELEGRAM_LIVE_CHECK_TOKEN to the bot's token; nothing was sent")
  expect(none.out).toBe('')
  expect(none.calls).toEqual([])
  const noChat = await check({ token: TOKEN, args: ['--pace', '0'] })
  expect(noChat.code).toBe(2)
  expect(noChat.err).toContain('live-check: no chat: name it with --chat; nothing was sent')
  expect(noChat.out).toBe('')
  expect(noChat.calls).toEqual([])
  for (const part of PARTS) expect(noChat.err).not.toContain(part)
}, BOUND)

test('where Telegram answers as the stand-in does, every case agrees, each send is silent, each message it took is deleted, and no part of the token shows', async () => {
  const r = await check({ token: TOKEN })
  expect(r.err).toBe('')
  expect(r.code).toBe(0)
  expect(r.lines.slice(0, -1).map(l => l.split(':')[0])).toEqual(CASES.map(c => `same     ${c.name}`))
  expect(r.lines.at(-1)).toBe(`${CASES.length} of ${CASES.length} cases agree`)
  const sends = r.calls.filter(c => SENDS.includes(c.method))
  // Each case sends once: its own message, or the one its edit edits.
  expect(sends.length).toBe(CASES.length)
  expect(sends.filter(c => String(c.payload.disable_notification) !== 'true')).toEqual([])
  const { taken, deleted } = deletes(r.calls)
  expect(taken.length).toBeGreaterThan(CASES.length / 2)
  expect(deleted).toEqual([...taken].sort((a, b) => a - b))
  for (const part of PARTS) expect(r.out + r.err).not.toContain(part)
}, BOUND)

test('each case where Telegram answers otherwise is named with both answers, without any part of the token, and the check exits 1', async () => {
  const r = await check({ token: TOKEN, rules: [
    { method: 'sendDocument', has: '"caption":"\\tx\\t"', uncaptioned: true },
    { method: 'sendMessage', has: '"text":"a\\rb"', error: { error_code: 400, description: 'Bad Request: message text is empty' } },
    { method: 'sendMessage', has: '"text":"a\\u0001b"', error: { error_code: 400, description: `Bad Request: ${TOKEN}, 4242 and test-bot-token` } },
  ] })
  expect(r.code).toBe(1)
  const differ = r.lines.filter(l => l.startsWith('DIFFERS'))
  expect(differ).toEqual([
    'DIFFERS  text-cr: Telegram refused: Bad Request: message text is empty; the stand-in text "a\\rb"; the update it bridged text "a\\rb"',
    'DIFFERS  text-control: Telegram refused: Bad Request: <token>, <token> and <token>; the stand-in text "a\\u0001b"; the update it bridged text "a\\u0001b"',
    expect.stringMatching(/^DIFFERS {2}caption-tab-ends: Telegram no caption; the stand-in caption "(x|\\tx\\t)"; the update it bridged caption "(x|\\tx\\t)"$/),
  ])
  expect(r.lines.filter(l => l.startsWith('same')).length).toBe(CASES.length - 3)
  expect(r.lines.at(-1)).toBe(`${CASES.length - 3} of ${CASES.length} cases agree; 3 differ: text-cr, text-control, caption-tab-ends`)
  for (const part of PARTS) expect(r.out + r.err).not.toContain(part)
  const { taken, deleted } = deletes(r.calls)
  expect(deleted).toEqual([...taken].sort((a, b) => a - b))
}, BOUND)

test('a run that stops partway deletes every message it took, and exits 2 naming where it stopped', async () => {
  // The first caption edit fails to reach Telegram, once the message it edits is sent.
  const r = await check({ token: TOKEN, rules: [{ method: 'editMessageCaption', times: 1, network: 'ECONNRESET' }] })
  const at = CASES.findIndex(c => c.method === 'editMessageCaption')
  expect(r.code).toBe(2)
  expect(r.err).toContain(`live-check: the run stopped after ${at} of ${CASES.length} cases: Network request for 'editMessageCaption' failed!`)
  expect(r.lines.slice(0, -1).map(l => l.split(':')[0])).toEqual(CASES.slice(0, at).map(c => `same     ${c.name}`))
  const failed = r.calls.findIndex(c => c.failed)
  expect(r.calls[failed]!.method).toBe('editMessageCaption')
  const { taken, deleted } = deletes(r.calls)
  expect(deleted).toEqual([...taken].sort((a, b) => a - b))
  // The message the failed edit was for is deleted after it.
  const base = r.calls[failed - 1]!
  expect(base.method).toBe('sendMessage')
  expect(r.calls.slice(failed + 1).map(c => [c.method, c.payload.message_id])).toEqual([['deleteMessage', base.message_id]])
}, BOUND)

test('calls to Telegram go a second apart, or --pace milliseconds apart', async () => {
  // Each run stops at its second text, which fails to reach Telegram.
  const rules = [{ method: 'sendMessage', skip: 1, times: 1, network: 'ECONNRESET' }]
  const gaps = (calls: (Call & { at: number })[]) => calls.slice(1).map((c, i) => c.at - calls[i]!.at)
  const slow = await check({ token: TOKEN, args: ['--chat', '5'], rules })
  expect(slow.code).toBe(2)
  expect(slow.calls.map(c => c.method)).toEqual(['sendMessage', 'deleteMessage', 'sendMessage'])
  for (const gap of gaps(slow.calls as (Call & { at: number })[])) expect(gap).toBeGreaterThanOrEqual(995)
  const paced = await check({ token: TOKEN, args: ['--chat', '5', '--pace', '300'], rules })
  expect(paced.calls.map(c => c.method)).toEqual(['sendMessage', 'deleteMessage', 'sendMessage'])
  for (const gap of gaps(paced.calls as (Call & { at: number })[])) {
    expect(gap).toBeGreaterThanOrEqual(295)
    expect(gap).toBeLessThan(995)
  }
}, BOUND)

test('a 429 waits out its retry_after and sends the call again', async () => {
  const r = await check({ token: TOKEN, rules: [{ method: 'sendMessage', times: 1,
    error: { error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } } }] })
  expect(r.code).toBe(0)
  expect(r.lines[0]).toBe('Telegram asks to wait 1 s before sendMessage; waiting')
  const [first, second] = r.calls.filter(c => c.method === 'sendMessage')
  expect(first!.refused).toBe('Too Many Requests: retry after 1')
  expect(second!.payload).toEqual(first!.payload)
  expect(second!.refused).toBeUndefined()
  expect(r.lines.at(-1)).toBe(`${CASES.length} of ${CASES.length} cases agree`)
}, BOUND)
