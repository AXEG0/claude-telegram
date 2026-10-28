import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import failureHooks from './fixtures/failure-hooks.json'
import turnHooks from './fixtures/turn-hooks.json'
import { apiError, CREDITS, jsonl, prompt, recorded, reply, text, upTo, type Line } from './fixtures/turns.ts'
import {
  answerAt, appendFailure, attribute, CAP_BYTES, CHUNK_BYTES, cleanFiles, cleanRecord, createFailureWatch, createRecordReader,
  failureFiles, failureRecord, failureText, FIRST_TIMEOUT_MS, LAYOUT_CHANGED, MAX_WAIT_MS, PENDING_MS, readClean,
  RESTORED_TEXT, TICK_MS, writeClean, type FailureRecord, type RunState,
} from './failures.ts'

const FIXTURES = join(import.meta.dir, 'fixtures', 'transcripts')
const fixture = (name: string) => join(FIXTURES, `${name}.jsonl`)
// Each test's folders go when it ends.
const made: string[] = []
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'failures-')); made.push(dir); return dir }
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const at = (line: Line) => Date.parse(line.timestamp)

// A failure record as the hook writes it for the error entry on `index`
// (counted from 1), the hook starting `delay` ms after the entry.
function recordFor(name: string, index: number, delay = 40, path = fixture(name)): FailureRecord {
  const line = recorded(name)[index - 1]!
  return { t: at(line) + delay, error: line.error, text: text(line), transcript: path }
}

const chatsOf = (name: string, index: number, claimed = new Set<string>(), path?: string) => {
  const a = attribute(recordFor(name, index, 40, path), claimed)
  if (a.state !== 'done') throw new Error(`pending: ${a.reason}`)
  return a
}

function runHook(input: object, env: Record<string, string>) {
  return Bun.spawnSync(['bun', join(import.meta.dir, 'hooks', 'turn-end.ts')], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env },
  })
}

const lines = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))

describe('the turn-end hook\'s records', () => {
  test('a main-session StopFailure appends its time, class, text and transcript; a subagent\'s or a helper\'s writes nothing', () => {
    const dir = scratch()
    const env = { TELEGRAM_STATE_DIR: dir, CLAUDE_PID: '4242' }
    expect(runHook(failureHooks.subagent_stop_failure, env).exitCode).toBe(0)
    expect(runHook(turnHooks.helper_stop_failure, env).exitCode).toBe(0)
    expect(existsSync(join(dir, 'outcomes'))).toBe(false)
    const before = Date.now()
    expect(runHook(turnHooks.main_stop_failure_402, env).exitCode).toBe(0)
    expect(runHook({ ...failureHooks.main_stop_failure, error: 'rate_limit' }, env).exitCode).toBe(0)
    const records = lines(join(dir, 'outcomes', 'failures-pid-4242.jsonl'))
    expect(records.map(r => ({ ...r, t: 0 }))).toEqual([
      { t: 0, error: 'unknown', text: CREDITS, transcript: turnHooks.main_stop_failure_402.transcript_path },
      { t: 0, error: 'rate_limit', text: failureHooks.main_stop_failure.last_assistant_message, transcript: failureHooks.main_stop_failure.transcript_path },
    ])
    expect(records[0].t).toBeGreaterThanOrEqual(before)
    expect(records[1].t).toBeGreaterThanOrEqual(records[0].t)
    // The turn's end is still marked, and only under turns/.
    expect(readdirSync(join(dir, 'turns')).sort()).toEqual(['pid-4242', `session-${failureHooks.main_stop_failure.session_id}`, `session-${turnHooks.main_stop_failure_402.session_id}`].sort())
    expect(readdirSync(join(dir, 'outcomes'))).toEqual(['failures-pid-4242.jsonl'])
  })

  test('the text and the details are written only when Claude Code gave them', () => {
    expect(failureRecord({ error: 'unknown', error_details: '402 from the gateway', transcript_path: '/srv/probe/t.jsonl' }, 5))
      .toEqual({ t: 5, error: 'unknown', details: '402 from the gateway', transcript: '/srv/probe/t.jsonl' })
    expect(failureRecord({ last_assistant_message: 'API Error: x', error_details: { status: 402 } }, 6))
      .toEqual({ t: 6, text: 'API Error: x', details: '{"status":402}' })
    expect(failureRecord({}, 7)).toEqual({ t: 7 })
    expect(cleanRecord({}, 8)).toEqual({ t: 8 })
  })

  test('a Stop writes its time, answer and transcript for the pid and the session, and an older record never replaces a newer one', () => {
    const dir = scratch()
    const before = Date.now()
    expect(runHook(turnHooks.stop_after_402, { TELEGRAM_STATE_DIR: dir, CLAUDE_PID: '4242' }).exitCode).toBe(0)
    const files = cleanFiles(dir, turnHooks.stop_after_402.session_id, [4242])
    expect(readdirSync(join(dir, 'outcomes')).sort()).toEqual(['clean-pid-4242', `clean-session-${turnHooks.stop_after_402.session_id}`])
    const rec = JSON.parse(readFileSync(files[0]!, 'utf8'))
    expect(rec).toEqual({ t: rec.t, text: 'OK-answer-1', transcript: turnHooks.stop_after_402.transcript_path })
    expect(rec.t).toBeGreaterThanOrEqual(before)
    expect(JSON.parse(readFileSync(files[1]!, 'utf8'))).toEqual(rec)
    writeClean(files, { t: rec.t - 1, text: 'older' })
    expect(readClean(files)).toEqual(rec)
    writeClean([files[1]!], { t: rec.t + 1, text: 'newer' })
    expect(readClean(files)).toEqual({ t: rec.t + 1, text: 'newer' })
  })

  test('SessionEnd writes no record', () => {
    const dir = scratch()
    expect(runHook({ session_id: 'sess-1', hook_event_name: 'SessionEnd' }, { TELEGRAM_STATE_DIR: dir, CLAUDE_PID: '4242' }).exitCode).toBe(0)
    expect(existsSync(join(dir, 'outcomes'))).toBe(false)
  })

  test('the hook deletes records older than a week', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'outcomes'))
    writeFileSync(join(dir, 'outcomes', 'failures-pid-7.jsonl'), '{"t":1}\n')
    writeFileSync(join(dir, 'outcomes', 'clean-pid-8'), '{"t":2}')
    const old = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(join(dir, 'outcomes', 'failures-pid-7.jsonl'), old, old)
    expect(runHook({ session_id: 'sess-1', hook_event_name: 'SessionEnd' }, { TELEGRAM_STATE_DIR: dir, CLAUDE_PID: '4242' }).exitCode).toBe(0)
    expect(readdirSync(join(dir, 'outcomes'))).toEqual(['clean-pid-8'])
  })

  test('the reader returns each record once, in time order across files, skipping a malformed line and a line not yet ended', () => {
    const dir = scratch()
    const [a, b] = failureFiles(dir, [7, 8])
    appendFailure(a!, { t: 30 })
    appendFailure(b!, { t: 20 })
    appendFileSync(a!, 'not json\n{"t":"soon"}\n')
    const reader = createRecordReader([a!, b!])
    expect(reader.read(0)).toEqual([{ t: 20 }, { t: 30 }])
    expect(reader.read(0)).toEqual([])
    appendFileSync(b!, '{"t":40')
    expect(reader.waiting()).toBe(true)
    expect(reader.read(0)).toEqual([])
    appendFileSync(b!, '}\n')
    appendFailure(a!, { t: 10 })
    expect(reader.read(15)).toEqual([{ t: 40 }])
    expect(reader.waiting()).toBe(false)
  })
})

describe('attribution, on recorded transcripts', () => {
  test('a turn\'s own start gives its chat; a message taken in mid-turn gives none; a queued message runs as its own turn', () => {
    const claimed = new Set<string>()
    const name = 'start-absorbed-own-turns'
    const take = (index: number) => { const a = chatsOf(name, index, claimed); claimed.add(a.entry.uuid); return a.chats }
    expect([take(12), take(41), take(52), take(59)]).toEqual([['1'], ['1'], ['1'], ['3']])
    expect(chatsOf('queued-alone', 33).chats).toEqual(['3'])
    expect(chatsOf('queued-behind-failing', 26).chats).toEqual(['1'])
    expect(chatsOf('queued-behind-failing', 31).chats).toEqual(['2'])
  })

  test('a mid-turn compaction: the summary is skipped, and the turn\'s start gives its chat', () => {
    const claimed = new Set<string>()
    const take = (index: number) => { const a = chatsOf('mid-turn-compaction', index, claimed); claimed.add(a.entry.uuid); return a.chats }
    expect([take(54), take(65), take(72)]).toEqual([['1'], ['1'], ['2']])
  })

  test('prompts Claude Code merged into one turn give each chat, and a message taken into the clean turn before gives none', () => {
    expect(chatsOf('merged-starts', 31).chats).toEqual(['2', '3'])
    expect(chatsOf('absorbed-into-earlier-turn', 32).chats).toEqual(['2', '3'])
  })

  test('a scheduled task\'s turn, a task notification\'s turn and a typed prompt\'s turn give no chat and no reason', () => {
    expect(chatsOf('scheduled-start', 46)).toEqual({ state: 'done', entry: expect.any(Object), chats: [] })
    expect(chatsOf('typed-and-task-turns', 32)).toEqual({ state: 'done', entry: expect.any(Object), chats: [] })
    const dir = scratch()
    const path = join(dir, 't.jsonl')
    const task = recorded('typed-and-task-turns')
    const failed = apiError('err-task', at(task[51]!) + 40, CREDITS)
    writeFileSync(path, jsonl([...upTo(task, 52), failed]))
    expect(attribute({ t: at(failed) + 40, text: CREDITS, transcript: path }, new Set()))
      .toEqual({ state: 'done', entry: { uuid: 'err-task', at: at(failed) }, chats: [] })
  })

  test('a prompt with an origin or a turn origin and no turn position gives no chat, with the reason', () => {
    expect(chatsOf('merged-starts-no-position', 31)).toEqual({ state: 'done', entry: expect.any(Object), chats: [], reason: LAYOUT_CHANGED })
    expect(chatsOf('scheduled-start-no-position', 46)).toEqual({ state: 'done', entry: expect.any(Object), chats: [], reason: LAYOUT_CHANGED })
  })

  test('each refused turn gives its chat, the one written out of order included; the nudge is skipped', () => {
    const claimed = new Set<string>()
    const take = (index: number) => { const a = chatsOf('refusals', index, claimed); claimed.add(a.entry.uuid); return a }
    const first = take(12)
    expect(first.chats).toEqual(['1'])
    expect(recordFor('refusals', 12).error).toBe('invalid_request')
    expect(take(39).chats).toEqual(['2'])
    expect(take(70).chats).toEqual([])
    expect(take(94).chats).toEqual(['5'])
  })

  test('another channel\'s message gives no chat, and the plugin\'s own source counts', () => {
    const dir = scratch()
    const path = join(dir, 't.jsonl')
    const merged = recorded('merged-starts')
    const source = (s: string) => merged.map((l, i) => i === 26 ? { ...l, message: { ...l.message, content: l.message.content.replace('source="telegram"', `source="${s}"`) } } : l)
    writeFileSync(path, jsonl(source('plugin:discord:discord')))
    expect(chatsOf('merged-starts', 31, new Set(), path).chats).toEqual(['3'])
    writeFileSync(path, jsonl(source('plugin:telegram:telegram')))
    expect(chatsOf('merged-starts', 31, new Set(), path).chats).toEqual(['2', '3'])
  })

  test('an error entry not written yet keeps the record pending', () => {
    const dir = scratch()
    const path = join(dir, 't.jsonl')
    writeFileSync(path, jsonl(upTo(recorded('merged-starts'), 30)))
    expect(attribute(recordFor('merged-starts', 31, 40, path), new Set())).toEqual({ state: 'pending', reason: 'error entry not found' })
    expect(attribute({ ...recordFor('merged-starts', 31), transcript: join(dir, 'missing.jsonl') }, new Set()).state).toBe('pending')
  })

  test('a turn start more than 64 MB from the end is not found, and one within it is', () => {
    const dir = scratch()
    const t0 = Date.parse('2026-10-27T15:00:00.000Z')
    const blob = JSON.stringify({ type: 'api-request-blob', blob: 'x'.repeat(CHUNK_BYTES - 64) }) + '\n'
    const build = (bytes: number) => {
      const path = join(dir, `t-${bytes}.jsonl`)
      writeFileSync(path, jsonl([prompt('p1', t0, '1', 1)]))
      for (let n = 0; n < Math.ceil(bytes / blob.length); n++) appendFileSync(path, blob)
      appendFileSync(path, jsonl([apiError('e1', t0 + 1000, CREDITS)]))
      return { t: t0 + 1040, text: CREDITS, transcript: path }
    }
    expect(attribute(build(CAP_BYTES - 2 * CHUNK_BYTES), new Set())).toEqual({ state: 'done', entry: { uuid: 'e1', at: t0 + 1000 }, chats: ['1'] })
    expect(attribute(build(CAP_BYTES + CHUNK_BYTES), new Set())).toEqual({ state: 'pending', reason: 'turn start not found within 64 MB' })
  })

  test('a line cut by a chunk\'s edge is read whole', () => {
    const dir = scratch()
    const path = join(dir, 't.jsonl')
    const t0 = Date.parse('2026-10-27T15:00:00.000Z')
    const start = jsonl([prompt('p1', t0, '1', 1)])
    const error = jsonl([apiError('e1', t0 + 1000, CREDITS)])
    // The prompt's line starts 100 bytes before the last chunk and ends inside it.
    const filler = JSON.stringify({ type: 'progress', pad: 'y'.repeat(CHUNK_BYTES - error.length - start.length + 100 - 30) }) + '\n'
    writeFileSync(path, start + filler + error)
    const size = Buffer.byteLength(start + filler + error)
    expect(size - CHUNK_BYTES).toBeLessThan(Buffer.byteLength(start))
    expect(size - CHUNK_BYTES).toBeGreaterThan(0)
    expect(attribute({ t: t0 + 1040, text: CREDITS, transcript: path }, new Set()))
      .toEqual({ state: 'done', entry: { uuid: 'e1', at: t0 + 1000 }, chats: ['1'] })
  })

  test('two failures 60 ms apart, with their hooks 40 or 80 ms late, give chat 1, then chat 3', () => {
    for (const delay of [40, 80]) {
      const claimed = new Set<string>()
      const one = attribute(recordFor('two-close-failures', 8, delay), claimed)
      if (one.state !== 'done') throw new Error('pending')
      claimed.add(one.entry.uuid)
      const two = attribute(recordFor('two-close-failures', 10, delay), claimed)
      expect([one.chats, two.state === 'done' && two.chats]).toEqual([['1'], ['3']])
    }
  })

  test('records with no text pair by time alone: each takes the oldest entry not yet claimed', () => {
    const claimed = new Set<string>()
    const { t } = recordFor('two-close-failures', 8, 80)
    const one = attribute({ t, transcript: fixture('two-close-failures') }, claimed)
    if (one.state !== 'done') throw new Error('pending')
    expect(one.chats).toEqual(['1'])
    claimed.add(one.entry.uuid)
    const two = attribute({ t: recordFor('two-close-failures', 10, 80).t, transcript: fixture('two-close-failures') }, claimed)
    expect(two.state === 'done' && two.chats).toEqual(['3'])
  })

  test('a record whose entry has not landed stays pending, though an unclaimed entry with its text sits 12 s earlier', () => {
    const dir = scratch()
    const path = join(dir, 't.jsonl')
    writeFileSync(path, jsonl(upTo(recorded('queued-behind-failing'), 30)))
    expect(attribute(recordFor('queued-behind-failing', 31, 40, path), new Set()).state).toBe('pending')
  })
})

// The watch the polling server runs, on a scratch state folder, with a fake
// clock, a fake Telegram and the bot lookups given.
type Answer = 'ok' | 'hang' | 'drop' | { error_code: number; description: string; parameters?: object } | { slowMs: number } | { preMs: number }
function harness(opts: { start: number; bots?: string[]; owner?: string; lookup?: (chat: string, signal: AbortSignal) => Promise<boolean>; dir?: string }) {
  const dir = opts.dir ?? scratch()
  let clock = opts.start
  const answers = new Map<string, Answer[]>()
  // What Telegram received, and what it answered.
  const delivered: { chat: string; text: string; at: number }[] = []
  const requests: { chat: string; text: string; at: number }[] = []
  const send = async (chat: string, text: string, signal: AbortSignal) => {
    requests.push({ chat, text, at: clock })
    const queued = answers.get(chat)
    const answer = queued?.length ? queued.shift()! : 'ok'
    const aborted = () => new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    if (answer === 'hang') return aborted()
    if (typeof answer === 'object' && 'error_code' in answer) throw Object.assign(new Error(answer.description), answer)
    // The request reaches Telegram late, so a message sent after it can arrive first.
    if (typeof answer === 'object' && 'preMs' in answer) await Bun.sleep(answer.preMs)
    delivered.push({ chat, text, at: clock })
    if (answer === 'drop') throw new TypeError('fetch failed: the connection was reset')
    if (typeof answer === 'object' && 'slowMs' in answer) return Promise.race([Bun.sleep(answer.slowMs), aborted()])
  }
  const lookups: string[] = []
  const logs: string[] = []
  const lookup = opts.lookup ?? (async (chat: string) => (opts.bots ?? []).includes(chat))
  const make = () => createFailureWatch({
    file: join(dir, 'failure-run.json'),
    failures: failureFiles(dir, [4242]),
    cleans: cleanFiles(dir, 'sess-1', [4242]),
    botChat: (chat, signal) => { lookups.push(chat); return lookup(chat, signal) },
    owner: opts.owner,
    send,
    log: line => logs.push(line),
    now: () => clock,
  })
  const h = {
    dir,
    watch: make(),
    requests, delivered, lookups, logs,
    answer: (chat: string, ...a: Answer[]) => answers.set(chat, a),
    set now(t: number) { clock = t },
    get now() { return clock },
    fail: (rec: FailureRecord) => appendFailure(failureFiles(dir, [4242])[0]!, rec),
    clean: (t: number, said?: string, transcript?: string) => writeClean(cleanFiles(dir, 'sess-1', [4242]), { t, ...(said ? { text: said } : {}), ...(transcript ? { transcript } : {}) }),
    // One tick, the fake clock moved on first.
    async tick(by = TICK_MS) { clock += by; await h.watch.tick() },
    restart() { h.watch = make() },
    state: (): RunState => JSON.parse(readFileSync(join(dir, 'failure-run.json'), 'utf8')),
    // Each chat's messages, in the order Telegram received them.
    texts: (chat: string) => delivered.filter(d => d.chat === chat).map(d => d.text),
  }
  return h
}

const merged = recorded('merged-starts')
// Before every recorded transcript, so a fresh watch reads all their records.
const START = Date.parse('2026-10-27T13:00:00.000Z')
// The merged turn's failure, as its hook recorded it (44.398), and the first
// turn's answer (44.224, "OK-answer-1"), which ends before it.
const FAIL = { t: at(merged[30]!) + 37, error: 'unknown', text: CREDITS, transcript: fixture('merged-starts') }
const NOTICE = failureText(FAIL)

describe('the record queue', () => {
  test('a record waits one tick, so a sibling\'s line landing later is handled first, in time order', async () => {
    const h = harness({ start: START })
    const one = { ...recordFor('two-close-failures', 8, 80), text: undefined, details: 'first' }
    const two = { ...recordFor('two-close-failures', 10, 80), text: undefined, details: 'second' }
    h.now = two.t + 10
    h.fail(two)
    await h.tick(0)
    expect(h.requests).toEqual([])
    h.now = two.t + 60
    h.fail(one)
    await h.tick(TICK_MS)
    expect(h.texts('1')).toEqual([failureText(one)])
    expect(h.texts('3')).toEqual([failureText(two)])
  })

  test('a pending record holds the records after it, so each takes its own entry', async () => {
    const dir = scratch()
    const late = join(dir, 'late.jsonl')
    const h = harness({ start: START, dir })
    const one = { ...recordFor('two-close-failures', 8, 80), text: undefined, details: 'first', transcript: late }
    const two = { ...recordFor('two-close-failures', 10, 80), text: undefined, details: 'second' }
    h.now = two.t
    h.fail(one)
    h.fail(two)
    await h.tick(TICK_MS)
    await h.tick(TICK_MS)
    expect(h.requests).toEqual([])
    expect(h.watch.unfinished()).toBe(true)
    copyFileSync(fixture('two-close-failures'), late)
    await h.tick(TICK_MS)
    expect(h.texts('1')).toEqual([failureText(one)])
    expect(h.texts('3')).toEqual([failureText(two)])
    expect(h.watch.unfinished()).toBe(false)
  })

  test('claims survive a restart: a record handled after it takes the next entry', async () => {
    const h = harness({ start: START })
    const one = recordFor('two-close-failures', 8, 80)
    const two = recordFor('two-close-failures', 10, 80)
    h.now = two.t
    h.fail(one)
    await h.tick(TICK_MS)
    expect(h.delivered.map(d => d.chat)).toEqual(['1'])
    h.restart()
    h.fail(two)
    await h.tick(TICK_MS)
    expect(h.delivered.map(d => d.chat)).toEqual(['1', '3'])
  })

  test('claims stamped more than ten seconds before the newest record finished are dropped', async () => {
    const h = harness({ start: START })
    const name = 'start-absorbed-own-turns'
    h.now = recordFor(name, 12).t
    h.fail(recordFor(name, 12))
    await h.tick(TICK_MS)
    expect(h.state().claimed.length).toBe(1)
    h.now = recordFor(name, 41).t
    h.fail(recordFor(name, 41))
    await h.tick(TICK_MS)
    expect(h.state().claimed).toEqual([{ uuid: expect.any(String), at: at(recorded(name)[40]!) }])
    expect(h.state().seen).toBe(recordFor(name, 41).t)
  })

  test('a restart before a record\'s one write handles it again from scratch, and after it, not at all', async () => {
    // The first server's lookup never answers, so the record never finishes.
    const h = harness({ start: START, lookup: (_, signal) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason))) })
    const one = recordFor('two-close-failures', 8, 80)
    h.now = one.t
    h.fail(one)
    void h.tick(TICK_MS)
    await Bun.sleep(50)
    expect(h.lookups).toEqual(['1'])
    expect(existsSync(join(h.dir, 'failure-run.json')) ? h.state().claimed : []).toEqual([])
    const again = harness({ start: h.now, dir: h.dir })
    again.now = h.now
    await again.tick(TICK_MS)
    expect(again.delivered.map(d => d.chat)).toEqual(['1'])
    const third = harness({ start: again.now, dir: h.dir })
    third.now = again.now
    await third.tick(TICK_MS)
    expect(third.requests).toEqual([])
  })

  test('a record whose entry lands two ticks late is still attributed; one that never lands is dropped after 30 s with its reason, and the next goes on', async () => {
    const dir = scratch()
    const path = join(dir, 't.jsonl')
    writeFileSync(path, jsonl(upTo(merged, 30)))
    const h = harness({ start: START, dir })
    h.now = FAIL.t
    h.fail({ ...FAIL, transcript: path })
    await h.tick(TICK_MS)
    await h.tick(TICK_MS)
    expect(h.requests).toEqual([])
    appendFileSync(path, jsonl([merged[30]!]))
    await h.tick(TICK_MS)
    expect(h.texts('2')).toEqual([NOTICE])
    expect(h.texts('3')).toEqual([NOTICE])

    const lost = harness({ start: START })
    const missing = join(dir, 'never.jsonl')
    lost.now = FAIL.t
    lost.fail({ ...FAIL, transcript: missing })
    lost.fail({ ...recordFor('merged-starts', 31, 80) })
    for (let waited = 0; waited < PENDING_MS; waited += TICK_MS) await lost.tick(TICK_MS)
    expect(lost.requests).toEqual([])
    await lost.tick(TICK_MS)
    expect(lost.state().reasons.map(r => r.reason)).toEqual([expect.stringMatching(/dropped: transcript not readable/)])
    expect(lost.delivered.map(d => d.chat)).toEqual(['2', '3'])
  })
})

describe('the run', () => {
  test('a run opens on a failure, tells each target once, and a new chat\'s failure mid-run gets its own notice', async () => {
    const h = harness({ start: START })
    h.now = FAIL.t
    h.fail(FAIL)
    await h.tick(TICK_MS)
    expect(h.delivered.map(d => d.chat)).toEqual(['2', '3'])
    // Chat 5's own turn, then chat 2's again, later in the same run.
    const t = h.now
    const path = join(h.dir, 't.jsonl')
    writeFileSync(path, jsonl([...merged, prompt('p5', t + 1000, '5', 4), apiError('e5', t + 1100, CREDITS), prompt('p2', t + 2000, '2', 5), apiError('e2', t + 2100, CREDITS)]))
    h.fail({ t: t + 1140, error: 'unknown', text: CREDITS, transcript: path })
    h.fail({ t: t + 2140, error: 'unknown', text: CREDITS, transcript: path })
    await h.tick(TICK_MS)
    await h.tick(TICK_MS)
    expect(h.delivered.map(d => d.chat)).toEqual(['2', '3', '5'])
    expect(h.state().run!.notified.map(n => n.chat)).toEqual(['2', '3', '5'])
    expect(h.state().run!.lastFailure).toBe(t + 2140)
    expect(h.state().run!.since).toBe(FAIL.t)
  })

  test('another bot\'s chat is told in the owner chat, once for several bots; with no owner chat, nobody is', async () => {
    const h = harness({ start: START, bots: ['2', '3'], owner: '1' })
    h.now = FAIL.t
    h.fail(FAIL)
    await h.tick(TICK_MS)
    expect(h.delivered).toEqual([{ chat: '1', text: NOTICE, at: h.now }])
    const none = harness({ start: START, bots: ['2', '3'] })
    none.now = FAIL.t
    none.fail(FAIL)
    await none.tick(TICK_MS)
    expect(none.requests).toEqual([])
    expect(none.state().run!.notified).toEqual([])
  })

  test('a lookup that fails is tried again each tick, then after 30 s the notice goes to the owner chat, or nowhere with none', async () => {
    let refuse = true
    const lookup = async (chat: string) => { if (refuse && chat === '2') throw new Error('getChatMember failed (400: chat not found)'); return false }
    const h = harness({ start: START, owner: '1', lookup })
    h.now = FAIL.t
    h.fail(FAIL)
    await h.tick(TICK_MS)
    await h.tick(TICK_MS)
    expect(h.requests).toEqual([])
    refuse = false
    await h.tick(TICK_MS)
    expect(h.delivered.map(d => d.chat)).toEqual(['2', '3'])

    refuse = true
    const late = harness({ start: START, owner: '1', lookup })
    late.now = FAIL.t
    late.fail(FAIL)
    for (let waited = 0; waited <= PENDING_MS + TICK_MS; waited += TICK_MS) await late.tick(TICK_MS)
    expect(late.delivered.map(d => d.chat).sort()).toEqual(['1', '3'])
    expect(late.state().reasons.map(r => r.reason)).toEqual([expect.stringMatching(/chat not found\); the notice for chat 2 goes to the owner chat/)])
    expect(late.lookups.filter(c => c === '2').length).toBeGreaterThan(2)

    const nobody = harness({ start: START, lookup })
    nobody.now = FAIL.t
    nobody.fail(FAIL)
    for (let waited = 0; waited <= PENDING_MS + TICK_MS; waited += TICK_MS) await nobody.tick(TICK_MS)
    expect(nobody.delivered.map(d => d.chat)).toEqual(['3'])
  })

  test('a lookup that gets no answer goes again with twice the time, as a send does', async () => {
    // Telegram answers chat 2's lookups after 12 s.
    const began: number[] = []
    const lookup = (chat: string, signal: AbortSignal) => chat !== '2' ? Promise.resolve(false) : new Promise<boolean>((resolve, reject) => {
      began.push(Date.now())
      const answer = setTimeout(() => resolve(false), 12_000)
      signal.addEventListener('abort', () => { clearTimeout(answer); reject(signal.reason) }, { once: true })
    })
    const h = harness({ start: START, owner: '1', lookup })
    h.now = FAIL.t
    h.fail(FAIL)
    await h.tick(TICK_MS)
    expect(h.delivered).toEqual([])
    await h.tick(TICK_MS)
    expect(began.length).toBe(2)
    expect(began[1]! - began[0]!).toBeGreaterThanOrEqual(FIRST_TIMEOUT_MS - 100)
    expect(h.delivered.map(d => d.chat)).toEqual(['2', '3'])
  }, 30_000)

  test('the run and the chats told survive a restart, so a told chat\'s next failure sends nothing', async () => {
    const h = harness({ start: START })
    h.now = FAIL.t
    h.fail(FAIL)
    await h.tick(TICK_MS)
    h.restart()
    const path = join(h.dir, 't.jsonl')
    writeFileSync(path, jsonl([...merged, prompt('p2', h.now + 1000, '2', 4), apiError('e2', h.now + 1100, CREDITS)]))
    h.fail({ t: h.now + 1140, error: 'unknown', text: CREDITS, transcript: path })
    await h.tick(TICK_MS)
    await h.tick(TICK_MS)
    expect(h.delivered.map(d => d.chat)).toEqual(['2', '3'])
    expect(h.state().seen).toBe(h.now - 2 * TICK_MS + 1140)
  })
})

describe('the state file', () => {
  test.each([
    ['a run without its targets', JSON.stringify({ seen: 0, claimed: [], run: { since: 1, lastFailure: 1 }, clean: null, closing: [], reasons: [], sends: [] })],
    ['a file cut short', '{"seen": 1, "claimed": ['],
    ['an array', '[]'],
  ])('%s is said once and replaced by an empty state, and the next failure is told', async (_, content) => {
    const dir = scratch()
    writeFileSync(join(dir, 'failure-run.json'), content)
    const h = harness({ start: START, dir })
    h.now = FAIL.t
    h.fail(FAIL)
    await h.tick(TICK_MS)
    await h.tick(TICK_MS)
    expect(h.delivered.map(d => d.chat)).toEqual(['2', '3'])
    expect(h.logs.filter(l => l.includes('holds no failure run state'))).toEqual([`${join(dir, 'failure-run.json')} holds no failure run state; starting from an empty one`])
    expect(h.state().run!.notified.map(n => n.chat)).toEqual(['2', '3'])
  })

  test('a missing file starts an empty state without a word', async () => {
    const h = harness({ start: START })
    h.now = FAIL.t
    h.fail(FAIL)
    await h.tick(TICK_MS)
    expect(h.logs.filter(l => l.includes('failure run state'))).toEqual([])
    expect(h.delivered.map(d => d.chat)).toEqual(['2', '3'])
  })
})

describe('the close', () => {
  // A transcript of the merged turn's failure, then chat 2's clean turn.
  function cleanTurn(dir: string, t: number, said = 'OK-later', entries?: Line[]) {
    const path = join(dir, 't.jsonl')
    writeFileSync(path, jsonl([...upTo(merged, 33), prompt('p2', t - 100, '2', 3), ...(entries ?? [reply('r2', t - 20, said)])]))
    return path
  }

  test('a clean record whose answer comes after the failure closes the run: back to normal once, after the notice', async () => {
    const h = harness({ start: START })
    h.now = FAIL.t
    const path = cleanTurn(h.dir, FAIL.t + 6000)
    h.fail({ ...FAIL, transcript: path })
    await h.tick(TICK_MS)
    h.clean(FAIL.t + 6000, 'OK-later', path)
    await h.tick(TICK_MS)
    await h.tick(TICK_MS)
    expect(h.texts('2')).toEqual([NOTICE, RESTORED_TEXT])
    expect(h.texts('3')).toEqual([NOTICE, RESTORED_TEXT])
    expect(h.state().run).toBeNull()
  })

  test('a late Stop hook, its answer older than the failure, does not close the run; a later clean turn does', async () => {
    const h = harness({ start: START })
    h.now = FAIL.t
    h.fail(FAIL)
    await h.tick(TICK_MS)
    // Turn 1's Stop hook, 23 ms after the failure's hook.
    h.clean(FAIL.t + 23, 'OK-answer-1', fixture('merged-starts'))
    await h.tick(TICK_MS)
    for (let waited = 0; waited <= PENDING_MS; waited += TICK_MS) await h.tick(TICK_MS)
    expect(h.texts('2')).toEqual([NOTICE])
    expect(h.state().run).not.toBeNull()
    // Turn 3's answer, "OK-answer-2", minutes after the failure.
    h.clean(at(merged[55]!) + 26, 'OK-answer-2', fixture('merged-starts'))
    await h.tick(TICK_MS)
    expect(h.texts('2')).toEqual([NOTICE, RESTORED_TEXT])
  })

  test('an answer not written yet closes the run at the tick it lands', async () => {
    const dir = scratch()
    const h = harness({ start: START, dir })
    h.now = FAIL.t
    const path = cleanTurn(dir, FAIL.t + 6000, 'OK-later', [])
    h.fail({ ...FAIL, transcript: path })
    await h.tick(TICK_MS)
    h.clean(FAIL.t + 6000, 'OK-later', path)
    await h.tick(TICK_MS)
    await h.tick(TICK_MS)
    expect(h.texts('2')).toEqual([NOTICE])
    appendFileSync(path, jsonl([reply('r2', FAIL.t + 5980, 'OK-later')]))
    await h.tick(TICK_MS)
    expect(h.texts('2')).toEqual([NOTICE, RESTORED_TEXT])
  })

  test('a text never found falls back after 30 s to the newest answer, with the reason', async () => {
    const h = harness({ start: START })
    h.now = FAIL.t
    const path = cleanTurn(h.dir, FAIL.t + 6000, 'OK-as-written')
    h.fail({ ...FAIL, transcript: path })
    await h.tick(TICK_MS)
    h.clean(FAIL.t + 6000, 'OK-as-reported', path)
    for (let waited = TICK_MS; waited < PENDING_MS; waited += TICK_MS) await h.tick(TICK_MS)
    expect(h.texts('2')).toEqual([NOTICE])
    await h.tick(TICK_MS)
    await h.tick(TICK_MS)
    expect(h.texts('2')).toEqual([NOTICE, RESTORED_TEXT])
    expect(h.state().reasons.map(r => r.reason)).toEqual([expect.stringMatching(/not found by its text/)])
  })

  test('a late Stop hook whose answer is older than the failure never closes the run, though the next turn\'s reply is newer; the next clean record replaces it', async () => {
    const h = harness({ start: START })
    h.now = FAIL.t
    const path = join(h.dir, 't.jsonl')
    // After the failure, chat 1's next turn has made a tool call when turn 1's Stop hook, late, records its answer.
    const call = { ...reply('call', FAIL.t + 15, ''), message: { ...reply('call', FAIL.t + 15, '').message, content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }] } }
    writeFileSync(path, jsonl([...upTo(merged, 33), prompt('p9', FAIL.t + 10, '1', 3), call]))
    h.fail({ ...FAIL, transcript: path })
    await h.tick(TICK_MS)
    h.clean(FAIL.t + 23, 'OK-answer-1', path)
    for (let waited = 0; waited <= PENDING_MS + TICK_MS; waited += TICK_MS) await h.tick(TICK_MS)
    expect(h.texts('2')).toEqual([NOTICE])
    expect(h.state().run).not.toBeNull()
    // Its text is found once, past the failure, and the record waits for the next.
    expect(h.state().clean!.older).toBe(true)
    appendFileSync(path, jsonl([reply('r9', h.now, 'OK-now')]))
    h.clean(h.now + 30, 'OK-now', path)
    await h.tick(TICK_MS)
    expect(h.texts('2')).toEqual([NOTICE, RESTORED_TEXT])
  })

  test('the answer search stops at an entry stamped at or before its bound', () => {
    // Turn 1's answer, "OK-answer-1", ends before the merged turn's failure.
    const late = { t: FAIL.t + 23, text: 'OK-answer-1', transcript: fixture('merged-starts') }
    expect(answerAt(late, true)).toBeLessThan(FAIL.t)
    expect(answerAt(late, true, FAIL.t)).toBeUndefined()
    expect(answerAt(late, false, FAIL.t)).toBeUndefined()
    // Turn 3's answer, "OK-answer-2", comes after it, and the bound leaves it found.
    const next = { t: at(merged[55]!) + 26, text: 'OK-answer-2', transcript: fixture('merged-starts') }
    expect(answerAt(next, true, FAIL.t)).toBe(answerAt(next, true)!)
    expect(answerAt(next, true, FAIL.t)).toBeGreaterThan(FAIL.t)
  })

  test('a clean record without text uses the newest reply', async () => {
    const h = harness({ start: START })
    h.now = FAIL.t
    const path = cleanTurn(h.dir, FAIL.t + 6000)
    h.fail({ ...FAIL, transcript: path })
    await h.tick(TICK_MS)
    h.clean(FAIL.t + 6000, undefined, path)
    await h.tick(TICK_MS)
    expect(h.texts('2')).toEqual([NOTICE, RESTORED_TEXT])
  })

  test('a message split over entries with one id matches on its joined text', async () => {
    const h = harness({ start: START })
    h.now = FAIL.t
    const t = FAIL.t + 6000
    const path = cleanTurn(h.dir, t, '', [reply('r2a', t - 30, 'First part.', 'msg-split'), { type: 'progress' }, reply('r2b', t - 20, 'Second part.', 'msg-split')])
    h.fail({ ...FAIL, transcript: path })
    await h.tick(TICK_MS)
    h.clean(t, 'First part.\nSecond part.', path)
    await h.tick(TICK_MS)
    expect(h.texts('2')).toEqual([NOTICE, RESTORED_TEXT])
  })

  test('the run closes only once every record read is finished, and a failure that tells nobody still extends it', async () => {
    const h = harness({ start: START })
    h.now = FAIL.t
    const path = join(h.dir, 't.jsonl')
    const sched = recorded('scheduled-start')
    writeFileSync(path, jsonl(upTo(merged, 33)))
    h.fail({ ...FAIL, transcript: path })
    await h.tick(TICK_MS)
    // A scheduled task's turn fails, then chat 2's turn ends clean before that failure's record is a tick old.
    const t = h.now
    appendFileSync(path, jsonl([{ ...sched[43]!, timestamp: new Date(t).toISOString() }, apiError('es', t + 50, CREDITS), prompt('p2', t + 1000, '2', 4), reply('r2', t + 1100, 'OK-clean')]))
    h.fail({ t: t + 90, error: 'unknown', text: CREDITS, transcript: path })
    h.clean(t + 1150, 'OK-clean', path)
    h.now = t + 1200
    await h.watch.tick()
    expect(h.texts('2')).toEqual([NOTICE])
    expect(h.state().run!.lastFailure).toBe(t + 90)
    await h.tick(TICK_MS)
    expect(h.texts('2')).toEqual([NOTICE, RESTORED_TEXT])
    expect(h.requests.length).toBe(4)
  })
})

describe('the sends', () => {
  const tooMany = (after: number) => ({ error_code: 429, description: `Too Many Requests: retry after ${after}`, parameters: { retry_after: after } })

  test('a 429 is sent again once its retry_after has passed', async () => {
    const h = harness({ start: START })
    h.answer('2', tooMany(6))
    h.now = FAIL.t
    h.fail(FAIL)
    await h.tick(TICK_MS)
    expect(h.requests.filter(r => r.chat === '2').length).toBe(1)
    await h.tick(TICK_MS)
    expect(h.requests.filter(r => r.chat === '2').length).toBe(1)
    await h.tick(TICK_MS)
    expect(h.texts('2')).toEqual([NOTICE])
    expect(h.state().run!.notified.find(n => n.chat === '2')!.sent).toBe(true)
  })

  test('a network error is sent again at the next tick, and a 5xx backs off, doubling up to a minute', async () => {
    const h = harness({ start: START })
    const broken = { error_code: 502, description: 'Bad Gateway' }
    h.answer('2', 'drop', broken, broken, broken, broken, broken, broken)
    h.answer('3', { error_code: 500, description: 'Internal Server Error' })
    h.now = FAIL.t
    h.fail(FAIL)
    for (let n = 0; n < 130; n++) await h.tick(TICK_MS / 2)
    const tries = h.requests.filter(r => r.chat === '2').map(r => r.at)
    // Delivered once with its answer lost, then six 502s, then accepted.
    expect(tries.map((t, i) => i ? t - tries[i - 1]! : 0).slice(1)).toEqual([4000, 8000, 16000, 32000, 60000, 60000, 60000])
    expect(h.texts('2')).toEqual([NOTICE, NOTICE])
    expect(h.texts('3')).toEqual([NOTICE])
    expect(h.requests.filter(r => r.chat === '3').map(r => r.at - tries[0]!)).toEqual([0, 4000])
  })

  test('400, 401 and 403 are final, and that chat gets no back to normal', async () => {
    for (const code of [400, 401, 403]) {
      const h = harness({ start: START })
      h.answer('2', { error_code: code, description: 'refused' })
      h.now = FAIL.t
      const path = join(h.dir, 't.jsonl')
      writeFileSync(path, jsonl([...upTo(merged, 33), prompt('p3', FAIL.t + 5900, '3', 3), reply('r3', FAIL.t + 5980, 'OK-later')]))
      h.fail({ ...FAIL, transcript: path })
      await h.tick(TICK_MS)
      await h.tick(TICK_MS)
      h.clean(FAIL.t + 6000, 'OK-later', path)
      await h.tick(TICK_MS)
      await h.tick(TICK_MS)
      expect(h.requests.filter(r => r.chat === '2').length).toBe(1)
      expect(h.texts('3')).toEqual([NOTICE, RESTORED_TEXT])
      expect(h.state().closing).toEqual([])
    }
  })

  test('a restart after the write and before Telegram took the notice sends it once, at the new server\'s first tick', async () => {
    const h = harness({ start: START })
    h.answer('2', { error_code: 502, description: 'Bad Gateway' })
    h.answer('3', { error_code: 502, description: 'Bad Gateway' })
    h.now = FAIL.t
    h.fail(FAIL)
    await h.tick(TICK_MS)
    expect(h.delivered).toEqual([])
    const after = harness({ start: h.now, dir: h.dir })
    after.now = h.now + TICK_MS
    await after.tick(0)
    expect(after.delivered.map(d => d.chat)).toEqual(['2', '3'])
    await after.tick(TICK_MS)
    expect(after.delivered.map(d => d.chat)).toEqual(['2', '3'])
  })

  test('an answer lost after Telegram took the notice sends it a second time', async () => {
    const h = harness({ start: START })
    h.answer('2', 'drop')
    h.now = FAIL.t
    h.fail(FAIL)
    await h.tick(TICK_MS)
    await h.tick(TICK_MS)
    await h.tick(TICK_MS)
    expect(h.texts('2')).toEqual([NOTICE, NOTICE])
    expect(h.texts('3')).toEqual([NOTICE])
  })

  test('a send that hangs is one request while ticks skip the step; at its timeout it counts as lost and goes again after the wait', async () => {
    const h = harness({ start: START })
    h.answer('2', 'hang')
    h.now = FAIL.t
    h.fail(FAIL)
    const began = Date.now()
    void h.tick(TICK_MS)
    // Ticks, 100 ms apart on the real clock, while the send hangs.
    while (Date.now() - began < FIRST_TIMEOUT_MS - 500) { await Bun.sleep(100); void h.watch.tick() }
    expect(h.requests.map(r => r.chat)).toEqual(['2'])
    while (!h.state().run!.notified.find(n => n.chat === '2')!.sent) await Bun.sleep(50)
    expect(Date.now() - began).toBeGreaterThanOrEqual(FIRST_TIMEOUT_MS - 100)
    expect(h.state().run!.notified.find(n => n.chat === '2')!.sent).toBe('retry: no answer in 8 s')
    await h.watch.tick()
    expect(h.texts('3')).toEqual([NOTICE])
    expect(h.requests.filter(r => r.chat === '2').length).toBe(1)
    await h.tick(TICK_MS)
    expect(h.requests.filter(r => r.chat === '2').length).toBe(2)
    expect(h.texts('2')).toEqual([NOTICE])
  }, 20_000)

  test('a Telegram that takes the notice but answers after 12 s is confirmed by the second try, which waits 16 s', async () => {
    const h = harness({ start: START })
    h.answer('2', { slowMs: 12_000 }, { slowMs: 12_000 })
    h.now = FAIL.t
    h.fail(FAIL)
    await h.tick(TICK_MS)
    expect(h.state().run!.notified.find(n => n.chat === '2')!.sent).toBe('retry: no answer in 8 s')
    await h.tick(TICK_MS)
    expect(h.state().run!.notified.find(n => n.chat === '2')!.sent).toBe(true)
    expect(h.texts('2')).toEqual([NOTICE, NOTICE])
  }, 30_000)

  test('a closed run\'s notice and back to normal go before a new run\'s notice to the same chat', async () => {
    const h = harness({ start: START })
    h.answer('2', tooMany(20))
    h.now = FAIL.t
    const path = join(h.dir, 't.jsonl')
    writeFileSync(path, jsonl([...upTo(merged, 33), prompt('p3', FAIL.t + 5900, '3', 3), reply('r3', FAIL.t + 5980, 'OK-later')]))
    h.fail({ ...FAIL, transcript: path })
    await h.tick(TICK_MS)
    h.clean(FAIL.t + 6000, 'OK-later', path)
    await h.tick(TICK_MS)
    expect(h.state().run).toBeNull()
    expect(h.state().closing.map(c => c.chat)).toEqual(['2'])
    // A new run: chat 2 fails again while its closed run's notice waits.
    const t = h.now
    appendFileSync(path, jsonl([prompt('p4', t, '2', 4), apiError('e4', t + 50, 'API Error: 500 Internal server error', 'server_error')]))
    h.fail({ t: t + 90, error: 'server_error', text: 'API Error: 500 Internal server error', transcript: path })
    for (let n = 0; n < 6; n++) await h.tick(TICK_MS)
    expect(h.texts('2')).toEqual([NOTICE, RESTORED_TEXT, failureText({ error: 'server_error', text: 'API Error: 500 Internal server error' })])
  })

  test('back to normal goes only after Telegram answered the notice, and a notice still retrying at the close keeps its pair', async () => {
    const h = harness({ start: START })
    h.answer('2', { preMs: 300 })
    h.answer('3', tooMany(10))
    h.now = FAIL.t
    const path = join(h.dir, 't.jsonl')
    writeFileSync(path, jsonl([...upTo(merged, 33), prompt('p4', FAIL.t + 5900, '4', 3), reply('r4', FAIL.t + 5980, 'OK-later')]))
    h.fail({ ...FAIL, transcript: path })
    h.clean(FAIL.t + 6000, 'OK-later', path)
    h.now = FAIL.t + 6000
    await h.tick(0)
    expect(h.delivered.map(d => `${d.chat} ${d.text === NOTICE ? 'notice' : 'restored'}`)).toEqual(['2 notice', '2 restored'])
    expect(h.state().closing.map(c => c.chat)).toEqual(['3'])
    await h.tick(TICK_MS)
    await h.tick(TICK_MS)
    await h.tick(TICK_MS)
    expect(h.texts('3')).toEqual([NOTICE, RESTORED_TEXT])
    expect(h.state().closing).toEqual([])
  })
})

describe('the notice', () => {
  test('carries the class on its own line, unknown included, and the text, or else the details', () => {
    expect(failureText({ error: 'unknown', text: CREDITS })).toBe(`⚠️ Claude's turn ended on an error.\nType: unknown\n${CREDITS}\nYou will get a message here when a turn ends without an error.`)
    expect(failureText({ error: 'rate_limit', text: 'API Error: 429' }).split('\n')[1]).toBe('Type: rate_limit')
    expect(failureText({ details: 'gateway said 402' }).split('\n').slice(1, 3)).toEqual(['Type: unknown', 'gateway said 402'])
    expect(failureText({}).split('\n')).toHaveLength(3)
  })

  test('is cut to fit 4096 characters', () => {
    const long = failureText({ error: 'invalid_request', text: 'x'.repeat(5000) })
    expect(long.length).toBe(4096)
    expect(long.endsWith('…\nYou will get a message here when a turn ends without an error.')).toBe(true)
    expect(failureText({ text: '😀'.repeat(3000) }).length).toBeLessThanOrEqual(4096)
  })
})
