// Tells a chat when the Claude turn its message started ends on an error, once
// per run of failures, and once more when turns end without an error again.
//
// The plugin's turn-end hook (hooks/turn-end.ts) writes two records under
// outcomes/ in the state directory. Each StopFailure of the main session
// appends a line to failures-pid-<Claude Code pid>.jsonl with the hook's time,
// the error's class, Claude Code's error text and the session transcript; one
// that carries an agent_id (a subagent's or a helper's) writes nothing. Each
// Stop rewrites clean-pid-<pid> and clean-session-<id> with its time, its
// answer and the transcript, keeping the newest.
//
// The server that polls reads each failure record once it is one tick old,
// and finds the failed turn in that transcript: the oldest unclaimed API-error
// entry stamped within the ten seconds up to the record's time (with the
// record's text, when it has one), then back to the prompt that started the
// turn, with any prompt Claude Code merged into the same turn. The chat of
// each Telegram message among those prompts gets the notice, or the owner chat
// for another bot's chat (see bots.ts). A message taken into a turn that was
// already running gets no notice of its own: the turn it joined was started by
// something else. A failed turn no Telegram message started (a scheduled task,
// a finished background task, the terminal) notifies nobody.
//
// A record whose entry has not landed yet waits, and holds the records after
// it, for 30 seconds at most. A prompt with an origin and no turn position
// means Claude Code's transcript layout changed: that record notifies nobody,
// and the reason goes to failure-run.json and stderr.
//
// The run of failures closes once every record read is finished and the newest
// clean record's answer sits in the transcript after the run's last failure:
// each chat told gets "back to normal" once, always after its notice. A send
// Telegram refuses or does not answer goes again later, as Telegram allows;
// a refusal for good (any other 4xx) ends that chat's messages. Each Telegram
// call carries its own timeout, and a step still running skips the next tick,
// so a call that hangs never sends the same message twice at once. A send
// whose answer is lost is sent again, so a lost answer can repeat a message.
//
// The state lives in failure-run.json in the state directory, written whole
// by the polling server alone, so a restart keeps the run, the chats told and
// what Telegram answered. A file that holds no run state is said once on
// stderr and replaced by an empty one.
//
// This file carries no dependencies beyond Node's, like typing.ts, so the hook
// can import it before `bun install` has run.

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createLogFollower } from './log-follower.ts'
import { REFRESH_MS } from './typing.ts'

// A record waits this long for a sibling hook's line, and a retry starts here.
export const TICK_MS = REFRESH_MS
// The error entry is stamped at most this long before the hook's own time.
export const WINDOW_MS = 10_000
// A record whose entry, turn start or chat kind cannot be read yet waits this
// long before it is dropped, or its notice goes to the owner chat.
export const PENDING_MS = 30_000
// The first try of a Telegram call waits this long for an answer; each try
// that gets none doubles it, up to MAX_WAIT_MS, as the wait before the next
// try doubles from one tick.
export const FIRST_TIMEOUT_MS = 2 * TICK_MS
export const MAX_WAIT_MS = 60_000
// The transcript is read from its end in chunks, up to the cap.
export const CHUNK_BYTES = 1 << 20
export const CAP_BYTES = 64 << 20
// The server holds the stuck and idle recovery this long at most while a
// failure record is unfinished.
export const HOLD_MS = 60_000
const REASONS_KEPT = 10
const SENDS_KEPT = 20

export const LAYOUT_CHANGED = 'transcript layout changed: a prompt with no turnPosition'
export const RESTORED_TEXT = '✅ Back to normal: Claude\'s turns end without an error again.'
const FAILURE_HEAD = '⚠️ Claude\'s turn ended on an error.'
const FAILURE_TAIL = 'You will get a message here when a turn ends without an error.'
const TEXT_LIMIT = 4096

export type FailureRecord = { t: number; error?: string; text?: string; details?: string; transcript?: string }
export type CleanRecord = { t: number; text?: string; transcript?: string }

// The notice: the error's class on its own line, unknown included, then Claude
// Code's error text, or else its details, cut so the message fits Telegram's
// 4096 characters.
export function failureText(rec: Pick<FailureRecord, 'error' | 'text' | 'details'>): string {
  const head = [FAILURE_HEAD, `Type: ${rec.error || 'unknown'}`]
  const body = rec.text ?? rec.details
  if (!body) return [...head, FAILURE_TAIL].join('\n')
  const room = TEXT_LIMIT - [...head, '', FAILURE_TAIL].join('\n').length
  let cut = body
  if (cut.length > room) {
    let end = room - 1
    if (/[\uDC00-\uDFFF]/.test(cut[end] ?? '')) end--
    cut = cut.slice(0, end) + '…'
  }
  return [...head, cut, FAILURE_TAIL].join('\n')
}

// ---- The hook's records ----

export function failureFiles(dir: string, pids: number[]): string[] {
  return pids.filter(pid => pid > 1).map(pid => join(dir, 'outcomes', `failures-pid-${pid}.jsonl`))
}

export function cleanFiles(dir: string, sessionId: string | undefined, pids: number[]): string[] {
  const files: string[] = []
  if (sessionId && /^[\w-]+$/.test(sessionId)) files.push(join(dir, 'outcomes', `clean-session-${sessionId}`))
  for (const pid of pids) if (pid > 1) files.push(join(dir, 'outcomes', `clean-pid-${pid}`))
  return files
}

const given = (v: unknown): string | undefined => typeof v === 'string' && v !== '' ? v : undefined

// A field Claude Code did not give stays out of the record.
export function failureRecord(input: Record<string, unknown>, at: number): FailureRecord {
  const rec: FailureRecord = { t: at }
  const error = given(input.error)
  if (error) rec.error = error
  const text = given(input.last_assistant_message)
  if (text) rec.text = text
  const details = input.error_details
  if (given(details)) rec.details = details as string
  else if (details && typeof details === 'object') rec.details = JSON.stringify(details)
  const transcript = given(input.transcript_path)
  if (transcript) rec.transcript = transcript
  return rec
}

export function cleanRecord(input: Record<string, unknown>, at: number): CleanRecord {
  const rec: CleanRecord = { t: at }
  const text = given(input.last_assistant_message)
  if (text) rec.text = text
  const transcript = given(input.transcript_path)
  if (transcript) rec.transcript = transcript
  return rec
}

export function appendFailure(file: string, rec: FailureRecord): void {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
  appendFileSync(file, JSON.stringify(rec) + '\n')
}

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
}

const isRecord = (v: unknown): v is { t: number } =>
  typeof v === 'object' && v !== null && typeof (v as { t?: unknown }).t === 'number' && Number.isFinite((v as { t: number }).t)

// Each file keeps the newest clean record: an older one never replaces it.
export function writeClean(files: string[], rec: CleanRecord): void {
  for (const file of files) {
    const old = readJson(file)
    if (isRecord(old) && old.t >= rec.t) continue
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(rec))
    renameSync(tmp, file)
  }
}

export function readClean(files: string[]): CleanRecord | undefined {
  let newest: CleanRecord | undefined
  for (const file of files) {
    const rec = readJson(file)
    if (isRecord(rec) && (!newest || rec.t > newest.t)) newest = rec as CleanRecord
  }
  return newest
}

// Follows the failure logs: each call returns the records appended since the
// last, newer than `after`, skipping a line that is not a record. A log the
// hook's weekly sweep deleted and a new failure wrote again is read from its
// start (see log-follower.ts).
export function createRecordReader(files: string[]) {
  const logs = files.map(createLogFollower)
  return {
    read(after: number): FailureRecord[] {
      const out: FailureRecord[] = []
      for (const log of logs) {
        for (const line of log.read()) {
          let rec: unknown
          try { rec = JSON.parse(line) } catch { continue }
          if (isRecord(rec) && rec.t > after) out.push(rec as FailureRecord)
        }
      }
      return out.sort((a, b) => a.t - b.t)
    },
    // Whether a log holds a line not read yet.
    waiting(): boolean {
      return logs.some(log => log.waiting())
    },
  }
}

// ---- Reading the transcript ----

// A transcript's lines from its end, read in chunks, up to the cap. A line cut
// by the cap is left out, and `capped` tells the caller the file goes on.
function backwardLines(path: string) {
  const fd = openSync(path, 'r')
  let pos = fstatSync(fd).size
  let read = 0
  let carry = Buffer.alloc(0)
  // The lines of the last chunk read, newest first, and the next to give.
  const lines: string[] = []
  let next = 0
  let done = false
  const state = { capped: false }
  function fill(): void {
    while (next === lines.length && !done) {
      if (pos === 0 || read >= CAP_BYTES) {
        done = true
        state.capped = pos > 0
        if (pos === 0 && carry.length) lines.push(carry.toString('utf8'))
        closeSync(fd)
        return
      }
      const len = Math.min(CHUNK_BYTES, pos, CAP_BYTES - read)
      pos -= len
      read += len
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, pos)
      const data = carry.length ? Buffer.concat([buf, carry]) : buf
      lines.length = next = 0
      let end = data.length
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 0x0a) continue
        if (end > i + 1) lines.push(data.subarray(i + 1, end).toString('utf8'))
        end = i
      }
      carry = Buffer.from(data.subarray(0, end))
    }
  }
  return {
    state,
    next(): string | undefined {
      fill()
      return next < lines.length ? lines[next++] : undefined
    },
    close(): void {
      if (!done) { done = true; closeSync(fd) }
    },
  }
}

// What attribution and the close read of one transcript entry.
type Entry = {
  type: string
  uuid?: string
  at: number
  apiError: boolean
  summary: boolean
  origin: boolean
  turnOrigin: boolean
  positioned: boolean
  turn?: unknown
  chat?: string
  text?: string
  message?: string
}

// The texts of a message's text blocks, joined by line breaks, as Claude Code
// builds last_assistant_message.
function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim()
}

// The chat a Telegram message came from, by the chat_id of the channel tag
// Claude Code wraps it in. Another channel on the same session has another
// source; only this plugin's server, named telegram, counts.
function channelChat(content: unknown): string | undefined {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter(b => b && b.type === 'text').map(b => b.text).join('\n') : ''
  const tag = /<channel\s([^>]*)>/.exec(text)
  if (!tag) return undefined
  const attrs = new Map<string, string>()
  for (const m of tag[1]!.matchAll(/(\w+)="([^"]*)"/g)) attrs.set(m[1]!, m[2]!)
  if (!/(^|:)telegram$/.test(attrs.get('source') ?? '')) return undefined
  const chat = attrs.get('chat_id')
  return chat && /^-?\d+$/.test(chat) ? chat : undefined
}

function entryOf(line: string): Entry | undefined {
  let e: Record<string, any>
  try { e = JSON.parse(line) } catch { return undefined }
  if (!e || typeof e !== 'object' || typeof e.type !== 'string') return undefined
  const at = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN
  const out: Entry = {
    type: e.type,
    uuid: typeof e.uuid === 'string' ? e.uuid : undefined,
    at,
    apiError: e.isApiErrorMessage === true,
    summary: e.isCompactSummary === true,
    origin: e.origin != null,
    turnOrigin: e.turnOrigin != null,
    positioned: e.turnPosition != null,
    turn: e.turnPosition?.turnIndex,
  }
  if (e.type === 'user' && e.origin?.kind === 'channel') out.chat = channelChat(e.message?.content)
  if (e.type === 'assistant') {
    out.text = textOf(e.message?.content)
    if (typeof e.message?.id === 'string') out.message = e.message.id
  }
  return out
}

export type Attribution =
  | { state: 'pending'; reason: string }
  | { state: 'done'; entry: { uuid: string; at: number }; chats: string[]; reason?: string }

// The chats whose messages started the turn the record's failure ended.
export function attribute(rec: FailureRecord, claimed: ReadonlySet<string>): Attribution {
  if (!rec.transcript) return { state: 'pending', reason: 'the record names no transcript' }
  let lines: ReturnType<typeof backwardLines>
  try {
    lines = backwardLines(rec.transcript)
  } catch (err) {
    return { state: 'pending', reason: `transcript not readable: ${err instanceof Error ? err.message : err}` }
  }
  try {
    const from = rec.t - WINDOW_MS
    // Entries read so far, newest first.
    const read: Entry[] = []
    let found = -1
    for (let raw = lines.next(); raw !== undefined; raw = lines.next()) {
      const e = entryOf(raw)
      if (!e) continue
      read.push(e)
      // An attachment carries its enqueue time, so only prompts and replies end the search.
      if ((e.type === 'user' || e.type === 'assistant') && e.at < from) break
      if (e.type === 'assistant' && e.apiError && e.uuid && !claimed.has(e.uuid)
        && e.at >= from && e.at <= rec.t && (rec.text === undefined || e.text === rec.text.trim())) found = read.length - 1
    }
    if (found < 0) {
      return { state: 'pending', reason: lines.state.capped ? 'error entry not found within 64 MB' : 'error entry not found' }
    }
    const error = read[found]!
    const entry = { uuid: error.uuid!, at: error.at }
    let i = found + 1
    const next = (): Entry | undefined => {
      if (i < read.length) return read[i++]
      for (let raw = lines.next(); raw !== undefined; raw = lines.next()) {
        const e = entryOf(raw)
        if (e) return e
      }
      return undefined
    }
    const chats: string[] = []
    const add = (chat?: string) => { if (chat && !chats.includes(chat)) chats.unshift(chat) }
    let started = false
    let turn: unknown
    for (let e = next(); e; e = next()) {
      if (!started) {
        // Replies, tool calls, attachments and bookkeeping lines inside the turn.
        if (e.type !== 'user' || e.summary) continue
        // Tool results, meta lines and Claude Code's own nudges.
        if (!e.origin && !e.turnOrigin && !e.positioned) continue
        if (!e.positioned) return { state: 'done', entry, chats: [], reason: LAYOUT_CHANGED }
        started = true
        turn = e.turn
        add(e.chat)
        continue
      }
      // Prompts Claude Code ran as one turn share its turn index.
      if (e.type !== 'user' && e.type !== 'assistant') continue
      if (e.type === 'user' && !e.summary && e.positioned && e.turn === turn) {
        add(e.chat)
        continue
      }
      break
    }
    if (!started) {
      return { state: 'pending', reason: lines.state.capped ? 'turn start not found within 64 MB' : 'turn start not found' }
    }
    return { state: 'done', entry, chats }
  } finally {
    lines.close()
  }
}

// The time of the clean turn's answer in its transcript: the newest assistant
// message that is not an error, stamped at or before the record's time, whose
// text is the record's when `byText`. A message is a run of assistant entries
// with one message id, no prompt between them, their texts joined by line
// breaks. Undefined when no such message is found. The walk stops at the
// first entry stamped at or before `after` that is not part of the message
// read, since an answer that old is not the one the caller waits for.
export function answerAt(rec: CleanRecord, byText: boolean, after = -Infinity): number | undefined {
  if (!rec.transcript) return undefined
  let lines: ReturnType<typeof backwardLines>
  try { lines = backwardLines(rec.transcript) } catch { return undefined }
  const want = rec.text?.trim()
  try {
    // A run read from its end: its entries in file order once complete.
    let run: Entry[] = []
    const judge = (): number | undefined => {
      for (let j = run.length - 1; j >= 0; j--) {
        const last = run[j]!
        if (!(last.at <= rec.t)) continue
        if (!byText) return last.at
        if (run.slice(0, j + 1).map(e => e.text).filter(Boolean).join('\n').trim() === want) return last.at
      }
      return undefined
    }
    for (let raw = lines.next(); ; raw = lines.next()) {
      const e = raw === undefined ? undefined : entryOf(raw)
      if (raw !== undefined && (!e || (e.type !== 'user' && e.type !== 'assistant'))) continue
      const joins = e && e.type === 'assistant' && !e.apiError && run.length > 0
        && e.message !== undefined && e.message === run[0]!.message
      if (joins) { run.unshift(e!); continue }
      if (run.length) {
        const at = judge()
        if (at !== undefined) return at
      }
      if (!e || e.at <= after) return undefined
      run = e.type === 'assistant' && !e.apiError ? [e] : []
    }
  } finally {
    lines.close()
  }
}

// ---- The run ----

// null: not tried; true: Telegram accepted it; 'retry: …' or 'final: …': its answer.
export type Sent = null | true | string
type Target = { chat: string; at: number; text: string; sent: Sent; retryAt?: number; tries?: number }
// A chat of a closed run still owed its notice, then back to normal.
type Closing = { chat: string; text: string; notice: Sent; restored: Sent; retryAt?: number; tries?: number }
export type RunState = {
  seen: number
  claimed: { uuid: string; at: number }[]
  run: null | { since: number; lastFailure: number; notified: Target[] }
  // older: its text is found only at or before the run's last failure, so it
  // never closes the run; the next clean record replaces it.
  clean: null | (CleanRecord & { since: number; fallback?: boolean; older?: boolean })
  closing: Closing[]
  reasons: { at: number; reason: string }[]
  sends: { at: number; chat: string; message: 'notice' | 'back to normal'; answer: string }[]
}

const isFinal = (s: Sent) => typeof s === 'string' && s.startsWith('final')

// A Telegram call's timeout after `tries` calls that failed: a send's or a
// bot lookup's, doubling from FIRST_TIMEOUT_MS up to MAX_WAIT_MS.
const callTimeout = (tries: number) => Math.min(FIRST_TIMEOUT_MS * 2 ** tries, MAX_WAIT_MS)

// failure-run.json as save() writes it, or undefined for anything else.
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const str = (v: unknown): v is string => typeof v === 'string'
const bool = (v: unknown): v is boolean => typeof v === 'boolean'
const obj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v)
const opt = (v: unknown, is: (v: unknown) => boolean) => v === undefined || is(v)
const all = (v: unknown, is: (v: unknown) => boolean) => Array.isArray(v) && v.every(is)
const sentOf = (v: unknown) => v === null || v === true || str(v)
const retries = (v: Record<string, any>) => opt(v.retryAt, num) && opt(v.tries, num)
function runStateOf(v: unknown): RunState | undefined {
  if (!obj(v)) return undefined
  const target = (t: unknown) => obj(t) && str(t.chat) && num(t.at) && str(t.text) && sentOf(t.sent) && retries(t)
  const closing = (c: unknown) => obj(c) && str(c.chat) && str(c.text) && sentOf(c.notice) && sentOf(c.restored) && retries(c)
  const run = v.run === null || (obj(v.run) && num(v.run.since) && num(v.run.lastFailure) && all(v.run.notified, target))
  const clean = v.clean === null || (obj(v.clean) && num(v.clean.t) && num(v.clean.since) && opt(v.clean.text, str)
    && opt(v.clean.transcript, str) && opt(v.clean.fallback, bool) && opt(v.clean.older, bool))
  const ok = num(v.seen) && all(v.claimed, c => obj(c) && str(c.uuid) && num(c.at)) && run && clean
    && all(v.closing, closing) && all(v.reasons, r => obj(r) && num(r.at) && str(r.reason))
    && all(v.sends, x => obj(x) && num(x.at) && str(x.chat) && str(x.message) && str(x.answer))
  return ok ? v as RunState : undefined
}

// A Telegram error's code and description, or the error's own message.
function describe(err: unknown): string {
  const e = err as { error_code?: unknown; description?: unknown } | undefined
  if (e && typeof e.error_code === 'number' && typeof e.description === 'string') return `${e.error_code}: ${e.description}`
  return err instanceof Error ? err.message : String(err)
}

export function createFailureWatch(opts: {
  // failure-run.json.
  file: string
  // The failure logs and clean records of this server's Claude Code process.
  failures: string[]
  cleans: string[]
  // Whether a chat is another bot's, asking Telegram for a chat not heard
  // from; and the owner chat, which gets a bot's notices.
  botChat: (chatId: string, signal: AbortSignal) => Promise<boolean>
  owner?: string
  send: (chatId: string, text: string, signal: AbortSignal) => Promise<unknown>
  log: (line: string) => void
  now?: () => number
}) {
  const now = opts.now ?? Date.now
  // A file that is not a run state, cut short or edited by hand, counts as
  // none: the run starts empty, said once.
  const loaded = existsSync(opts.file) ? runStateOf(readJson(opts.file)) : undefined
  if (existsSync(opts.file) && !loaded) opts.log(`${opts.file} holds no failure run state; starting from an empty one`)
  const fresh = !loaded
  const started = now()
  const state: RunState = loaded ?? { seen: 0, claimed: [], run: null, clean: null, closing: [], reasons: [], sends: [] }
  const reader = createRecordReader(opts.failures)
  // With no state, the records written before the server started are an
  // earlier session's.
  const after = () => Math.max(state.seen, fresh ? started - 1 : 0)
  // lookups: each chat's failed lookups, which make its next lookup's timeout grow.
  type Queued = { rec: FailureRecord; firstTry?: number; result?: Extract<Attribution, { state: 'done' }>; targets: Map<string, string | null>; lookups: Map<string, number> }
  const queue: Queued[] = []
  // Targets of the records finished since told() was last called.
  const told = new Set<string>()
  let running: Promise<void> | undefined

  function save(): void {
    mkdirSync(join(opts.file, '..'), { recursive: true, mode: 0o700 })
    const tmp = `${opts.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n', { mode: 0o600 })
    renameSync(tmp, opts.file)
  }

  function note(reason: string): void {
    state.reasons.push({ at: now(), reason })
    state.reasons.splice(0, Math.max(0, state.reasons.length - REASONS_KEPT))
    opts.log(reason)
  }

  // A record finished: its claim, `seen` and its new targets in one write, so
  // a restart handles it again from scratch or not at all.
  function finish(q: Queued, reason?: string): void {
    queue.shift()
    if (q.result) state.claimed.push(q.result.entry)
    state.seen = q.rec.t
    state.claimed = state.claimed.filter(c => c.at >= state.seen - WINDOW_MS)
    if (reason) note(reason)
    const run = state.run!
    for (const chat of q.result?.chats ?? []) {
      const target = q.targets.get(chat)
      if (!target) continue
      told.add(target)
      if (run.notified.some(n => n.chat === target)) continue
      run.notified.push({ chat: target, at: now(), text: failureText(q.rec), sent: null })
    }
    save()
  }

  async function attributeQueue(): Promise<void> {
    while (queue.length) {
      const q = queue[0]!
      if (now() - q.rec.t < TICK_MS) return
      q.firstTry ??= now()
      if (!q.result) {
        const claimed = new Set(state.claimed.map(c => c.uuid))
        const a = attribute(q.rec, claimed)
        if (a.state === 'pending') {
          if (now() - q.firstTry < PENDING_MS) return
          finish(q, `failure at ${new Date(q.rec.t).toISOString()} dropped: ${a.reason}`)
          continue
        }
        q.result = a
      }
      let waiting = false
      for (const chat of q.result.chats) {
        if (q.targets.has(chat)) continue
        const tries = q.lookups.get(chat) ?? 0
        try {
          const bot = await opts.botChat(chat, AbortSignal.timeout(callTimeout(tries)))
          q.targets.set(chat, bot ? opts.owner ?? null : chat)
        } catch (err) {
          q.lookups.set(chat, tries + 1)
          // A chat whose kind Telegram did not confirm gets nothing.
          if (now() - q.firstTry < PENDING_MS) { waiting = true; continue }
          q.targets.set(chat, opts.owner ?? null)
          note(`${describe(err)}; the notice for chat ${chat} goes to ${opts.owner ? 'the owner chat' : 'nobody, with no owner chat'}`)
        }
      }
      if (waiting) return
      finish(q, q.result.reason && `failure at ${new Date(q.rec.t).toISOString()} notifies nobody: ${q.result.reason}`)
    }
  }

  function checkClose(): void {
    const run = state.run
    if (!run) return
    const rec = readClean(opts.cleans)
    // An answer stamped before its own hook's time, and so before the run's
    // last failure, can never close it.
    if (rec && rec.t > run.lastFailure && (!state.clean || rec.t > state.clean.t)) {
      state.clean = { ...rec, since: now() }
      save()
    }
    if (state.clean && state.clean.t <= run.lastFailure) { state.clean = null; save() }
    if (!state.clean || queue.length) return
    const clean = state.clean
    if (clean.older) return
    // Each tick's walk ends at the run's last failure: no answer stamped at or
    // before it can close the run.
    const byText = clean.text !== undefined && !clean.fallback
    let at = answerAt(clean, byText, run.lastFailure)
    if (at === undefined && byText && now() - clean.since >= PENDING_MS) {
      // One walk past the last failure tells a text found only before it,
      // which never closes the run, from a text found nowhere, which falls
      // back to the newest answer.
      const found = answerAt(clean, true)
      if (found !== undefined && found > run.lastFailure) at = found
      else if (found !== undefined) {
        clean.older = true
        save()
        return
      } else {
        clean.fallback = true
        note('the clean turn\'s answer was not found by its text; its newest answer counts instead')
        save()
        at = answerAt(clean, false, run.lastFailure)
      }
    }
    if (at === undefined || at <= run.lastFailure) return
    for (const n of run.notified) {
      if (isFinal(n.sent)) continue
      state.closing.push({ chat: n.chat, text: n.text, notice: n.sent, restored: null, retryAt: n.retryAt, tries: n.tries })
    }
    state.run = null
    state.clean = null
    save()
  }

  // One message to the entry's chat; Telegram's answer, with the entry's next
  // try set from it.
  async function deliver(entry: { chat: string; retryAt?: number; tries?: number }, message: 'notice' | 'back to normal', text: string): Promise<Sent> {
    const tries = entry.tries ?? 0
    const timeout = callTimeout(tries)
    const signal = AbortSignal.timeout(timeout)
    let answer: Sent
    try {
      await opts.send(entry.chat, text, signal)
      delete entry.retryAt
      delete entry.tries
      answer = true
    } catch (err) {
      const e = err as { error_code?: unknown; parameters?: { retry_after?: unknown } }
      const code = typeof e?.error_code === 'number' ? e.error_code : undefined
      if (code === 429) {
        const after = Number(e.parameters?.retry_after)
        entry.retryAt = now() + (Number.isFinite(after) && after > 0 ? after * 1000 : TICK_MS)
        answer = `retry: ${describe(err)}`
      } else if (code !== undefined && code >= 400 && code < 500) {
        answer = `final: ${describe(err)}`
      } else {
        // A server error, a network error or no answer in time: the next try
        // waits twice as long as the last, and so does its timeout.
        entry.retryAt = now() + Math.min(TICK_MS * 2 ** tries, MAX_WAIT_MS)
        entry.tries = tries + 1
        answer = `retry: ${signal.aborted ? `no answer in ${timeout / 1000} s` : describe(err)}`
      }
    }
    const shown = answer === true ? 'accepted' : answer
    state.sends.push({ at: now(), chat: entry.chat, message, answer: shown })
    state.sends.splice(0, Math.max(0, state.sends.length - SENDS_KEPT))
    opts.log(`${message === 'notice' ? 'failure notice' : 'back to normal'} to ${entry.chat}: ${shown}`)
    return answer
  }

  // Every message due, one at a time. A chat reads a closed run's notice and
  // back to normal before anything else.
  async function sendDue(): Promise<void> {
    const owed = new Set<string>()
    for (const c of [...state.closing]) {
      if (owed.has(c.chat)) continue
      if (now() < (c.retryAt ?? 0)) { owed.add(c.chat); continue }
      if (c.notice !== true) c.notice = await deliver(c, 'notice', c.text)
      if (c.notice === true) c.restored = await deliver(c, 'back to normal', RESTORED_TEXT)
      if (isFinal(c.notice) || c.restored === true || isFinal(c.restored)) state.closing.splice(state.closing.indexOf(c), 1)
      else owed.add(c.chat)
      save()
    }
    for (const n of state.run?.notified ?? []) {
      if (n.sent === true || isFinal(n.sent) || owed.has(n.chat)) continue
      if (now() < (n.retryAt ?? 0)) continue
      n.sent = await deliver(n, 'notice', n.text)
      save()
    }
  }

  async function step(): Promise<void> {
    const records = reader.read(after())
    for (const rec of records) {
      queue.push({ rec, targets: new Map(), lookups: new Map() })
      // Every failure extends the run, whether or not it notifies anyone.
      if (!state.run) state.run = { since: rec.t, lastFailure: rec.t, notified: [] }
      else state.run.lastFailure = Math.max(state.run.lastFailure, rec.t)
    }
    if (records.length) {
      queue.sort((a, b) => a.rec.t - b.rec.t)
      save()
    }
    await attributeQueue()
    checkClose()
    await sendDue()
  }

  return {
    // One step at a time: a tick that finds the last step still running skips.
    tick(): Promise<void> {
      if (running) return running
      running = step()
        .catch(err => opts.log(`failure notices: ${err instanceof Error ? err.message : err}`))
        .finally(() => { running = undefined })
      return running
    },
    // Whether a failure record is read and not finished, or written and not read.
    unfinished(): boolean {
      return queue.length > 0 || reader.waiting()
    },
    // The chats told of a failure since the last call.
    told(): string[] {
      const out = [...told]
      told.clear()
      return out
    },
  }
}
