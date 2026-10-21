// Answer buttons: reply and edit_message put inline buttons under a message,
// and a press reaches Claude once, as an event marked button="<label>". The
// keyboard then becomes one disabled button showing the choice.
//
// Every server on the state folder, polling or not, keeps one record there
// (buttons.json): for each message carrying buttons set through reply or
// edit_message, the id of the keyboard it carries now and, once a press takes
// it, the label that took it. A reply reserves its keyboard id for the chat
// before it sends and joins the message id to it after; a press that arrives
// first joins it itself. Every change to the record happens under one flock
// on buttons.lock, which the holder's death releases, taken by a non-blocking
// try retried asynchronously so a wait never stops the event loop.
//
// A button's callback data is BUTTON_PREFIX, the keyboard id and the
// button's index, never its label, so a label's length never meets Telegram's
// 64-byte limit. Keyboard ids come from the record's counter, started from
// the clock's milliseconds when the record is new, so an id never repeats.

import { closeSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import type { Inbound } from './batch.ts'
import { metaText } from './reply.ts'

export const BUTTON_PREFIX = 'btn:'
export const MAX_ROWS = 4
export const MAX_PER_ROW = 4
export const MAX_LABEL = 40
// Entries in the record, reservations and taken entries included.
export const RECORD_MAX = 1000
// A Telegram call made under the lock gives up after this long.
export const LOCK_CALL_MS = 10_000
// How often a wait for the lock tries again.
export const LOCK_RETRY_MS = 5

// What a press is answered with when it delivers nothing.
export const NOT_ON_MESSAGE = 'This button is not on its message.'
export const CLOSED = 'This question is closed.'
export const PRESS_AGAIN = 'Not received. Please press again.'

const SHAPE = `buttons must be 1 to ${MAX_ROWS} rows of 1 to ${MAX_PER_ROW} labels`

// Why Telegram or the event would not give a label back as sent, if so.
// tdlib refuses text that is not UTF-8 and strips some characters as empty;
// its text cleaning and the event's metaText change the others listed here.
export function labelProblem(label: string): string | undefined {
  const points = [...label].length
  if (points < 1 || points > MAX_LABEL) return `is ${points} characters; a label is 1 to ${MAX_LABEL}`
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(label)) return 'holds a lone surrogate'
  if (/[\u0000-\u001F\u007F-\u009F]/.test(label)) return 'holds a control character'
  if (/^[ \u180E\u200B-\u200F\u2800\uFFFC\u{E0000}-\u{E007F}]*$/u.test(label)) return 'is blank once Telegram strips its invisible characters'
  // JavaScript's \s, which metaText folds, counts U+FEFF as whitespace.
  if (/[^\S ]|^ | $| {2}/.test(label)) return 'holds whitespace other than single spaces between words'
  if (/[\u2028-\u202E]|[\u200E\u200F]{2}|[\u030A\u0333\u033F]/.test(label)) return 'holds a character Telegram changes (U+2028 to U+202E, two or more of U+200E and U+200F in a row, U+030A, U+0333 or U+033F)'
  if (/["<>[\];]/.test(label)) return 'holds a double quote, an angle bracket, a square bracket or a semicolon'
  return undefined
}

// The rows a tool call asked for. A reply's buttons are never empty; an edit's
// may be, which removes them.
export function parseButtons(input: unknown, allowEmpty: boolean): string[][] {
  if (!Array.isArray(input)) throw new Error(SHAPE)
  if (input.length === 0) {
    if (allowEmpty) return []
    throw new Error(`${SHAPE}; an empty list is refused`)
  }
  if (input.length > MAX_ROWS) throw new Error(SHAPE)
  const seen = new Set<string>()
  for (const row of input) {
    if (!Array.isArray(row) || row.length < 1 || row.length > MAX_PER_ROW) throw new Error(SHAPE)
    for (const label of row) {
      if (typeof label !== 'string') throw new Error(`${SHAPE}, each a string`)
      const problem = labelProblem(label)
      if (problem) throw new Error(`button label ${JSON.stringify(label)} ${problem}`)
      if (seen.has(label)) throw new Error(`button label ${JSON.stringify(label)} appears twice; labels differ across the keyboard`)
      seen.add(label)
    }
  }
  return input as string[][]
}

export function buttonData(keyboard: number, index: number): string {
  return `${BUTTON_PREFIX}${keyboard}:${index}`
}

export function parseButtonData(data: string): { keyboard: number; index: number } | undefined {
  const m = /^btn:(\d{1,16}):(\d{1,2})$/.exec(data)
  if (!m) return undefined
  const keyboard = Number(m[1])
  return Number.isSafeInteger(keyboard) ? { keyboard, index: Number(m[2]) } : undefined
}

export type Markup = { inline_keyboard: { text: string; callback_data?: string; disabled?: object }[][] }

export function keyboardOf(rows: string[][], keyboard: number): Markup {
  let index = 0
  return { inline_keyboard: rows.map(row => row.map(text => ({ text, callback_data: buttonData(keyboard, index++) }))) }
}

// One Bot API DisabledButton, which does nothing when tapped, showing label.
export function chosen(label: string): Markup {
  return { inline_keyboard: [[{ text: label, disabled: {} }]] }
}

// The text of the button on msg's own keyboard whose data is data; undefined
// when Telegram returned the press without the message's keyboard, or the
// data is not on it, as for a button written into a rich message's body.
export function onKeyboard(msg: unknown, data: string): string | undefined {
  const rows = (msg as { reply_markup?: { inline_keyboard?: unknown } } | undefined)?.reply_markup?.inline_keyboard
  if (!Array.isArray(rows)) return undefined
  for (const row of rows) {
    if (!Array.isArray(row)) continue
    for (const b of row as { text?: unknown; callback_data?: unknown }[]) {
      if (b?.callback_data === data && typeof b.text === 'string') return b.text
    }
  }
  return undefined
}

type ApiError = { error_code?: number; description?: string } | undefined

// A 400 that refuses the keyboard itself, such as BUTTON_DATA_INVALID,
// REPLY_MARKUP_INVALID or "reply markup is too long": the call that carried
// it fails at once, with no plain copy.
export function keyboardRefused(err: unknown): boolean {
  const e = err as ApiError
  return e?.error_code === 400 && /button|keyboard|reply markup|reply_markup/i.test(e.description ?? '')
}

export function notModified(err: unknown): boolean {
  return /message is not modified/i.test((err as ApiError)?.description ?? '')
}

export function messageGone(err: unknown): boolean {
  return /message to edit not found/i.test((err as ApiError)?.description ?? '')
}

// A Telegram call made under the lock that did not answer in time. It counts
// as not refused: it may still land.
export class GaveUp extends Error {}

export async function withinLimit<T>(run: (signal: AbortSignal) => Promise<T>, ms: number = LOCK_CALL_MS): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new GaveUp(`Telegram did not answer within ${ms / 1000} s; the change may still land`))
      controller.abort()
    }, ms)
  })
  try {
    return await Promise.race([run(controller.signal), late])
  } finally {
    clearTimeout(timer)
  }
}

// The record. An entry without a message is a reservation; keyboard null is a
// removal under way; rows are the keyboard's labels, by row; taken is a swap
// still pending.
export type Entry = { chat: string; message?: number; keyboard: number | null; rows?: string[][]; taken?: string }
export type ButtonRecord = { next: number; entries: Entry[] }

function validEntry(e: unknown): e is Entry {
  const x = e as Entry
  return !!x && typeof x === 'object' && typeof x.chat === 'string'
    && (x.message === undefined || Number.isSafeInteger(x.message))
    && (x.keyboard === null || Number.isSafeInteger(x.keyboard))
    && (x.rows === undefined || Array.isArray(x.rows) && x.rows.every(row => Array.isArray(row) && row.every(label => typeof label === 'string')))
    && (x.taken === undefined || typeof x.taken === 'string')
}

// Room for one more entry: the oldest go, with no Telegram call.
function open(rec: ButtonRecord, entry: Entry): void {
  while (rec.entries.length >= RECORD_MAX) rec.entries.shift()
  rec.entries.push(entry)
}

export function newKeyboard(rec: ButtonRecord): number {
  return rec.next++
}

export function reserve(rec: ButtonRecord, chat: string, rows: string[][]): number {
  const keyboard = newKeyboard(rec)
  open(rec, { chat, keyboard, rows })
  return keyboard
}

export function entryOf(rec: ButtonRecord, chat: string, message: number): Entry | undefined {
  return rec.entries.find(e => e.chat === chat && e.message === message)
}

function reservationOf(rec: ButtonRecord, chat: string, keyboard: number): Entry | undefined {
  return rec.entries.find(e => e.chat === chat && e.message === undefined && e.keyboard === keyboard)
}

// Joins a reply's message to its reservation. A reservation a press already
// joined, or one no longer held, is left as it is.
export function join(rec: ButtonRecord, chat: string, keyboard: number, message: number): boolean {
  const r = reservationOf(rec, chat, keyboard)
  if (!r) return false
  rec.entries = rec.entries.filter(e => e === r || !(e.chat === chat && e.message === message))
  r.message = message
  return true
}

// Drops a reservation that never got its message.
export function unreserve(rec: ButtonRecord, chat: string, keyboard: number): boolean {
  const r = reservationOf(rec, chat, keyboard)
  if (!r) return false
  rec.entries = rec.entries.filter(e => e !== r)
  return true
}

export type Verdict = 'open' | 'reserved' | 'taken' | 'closed'

// How the record judges a press on keyboard under message.
export function judge(rec: ButtonRecord, chat: string, message: number, keyboard: number): Verdict {
  const e = entryOf(rec, chat, message)
  if (e && e.keyboard === keyboard) return e.taken === undefined ? 'open' : 'taken'
  if (reservationOf(rec, chat, keyboard)) return 'reserved'
  return 'closed'
}

// Records a press's take, joining a reservation first. False when the record
// no longer lets the press count.
export function take(rec: ButtonRecord, chat: string, message: number, keyboard: number, label: string): boolean {
  const verdict = judge(rec, chat, message, keyboard)
  if (verdict === 'reserved') join(rec, chat, keyboard, message)
  else if (verdict !== 'open') return false
  entryOf(rec, chat, message)!.taken = label
  return true
}

// Ends the entry of message, if it still carries keyboard (any, if omitted).
export function drop(rec: ButtonRecord, chat: string, message: number, keyboard?: number | null): boolean {
  const before = rec.entries.length
  rec.entries = rec.entries.filter(e => !(e.chat === chat && e.message === message && (keyboard === undefined || e.keyboard === keyboard)))
  return rec.entries.length !== before
}

// Names a new keyboard with its rows, or none, as message's current one before
// the call that sets it; returns what to put back if Telegram refuses the
// change. An entry whose keyboard is set again moves to the newest place.
export function replace(rec: ButtonRecord, chat: string, message: number, keyboard: number | null, rows?: string[][]): Entry | undefined {
  const before = entryOf(rec, chat, message)
  const was = before && { ...before }
  if (before) rec.entries = rec.entries.filter(e => e !== before)
  if (keyboard !== null) open(rec, { chat, message, keyboard, rows })
  else if (before) open(rec, { chat, message, keyboard })
  return was
}

// Puts back what replace() found, after Telegram refused the change.
export function restore(rec: ButtonRecord, chat: string, message: number, was: Entry | undefined): void {
  rec.entries = rec.entries.filter(e => !(e.chat === chat && e.message === message))
  if (was) open(rec, was)
}

// The flock(2) of the C library, through Bun's FFI; undefined where neither
// libc loads. LOCK_EX | LOCK_NB, and closing the descriptor releases it.
const LOCK_EX = 2
const LOCK_NB = 4
let flockFn: ((fd: number, op: number) => number) | null | undefined
function flock(): ((fd: number, op: number) => number) | undefined {
  if (flockFn !== undefined) return flockFn ?? undefined
  flockFn = null
  try {
    const { dlopen, FFIType } = require('bun:ffi') as typeof import('bun:ffi')
    for (const name of ['libc.so.6', 'libc.dylib', 'libSystem.B.dylib']) {
      try {
        const lib = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } })
        flockFn = (fd, op) => lib.symbols.flock(fd, op) as number
        break
      } catch {}
    }
  } catch {}
  return flockFn ?? undefined
}

// Takes the exclusive lock on path: a fresh descriptor for each holder, so a
// server's own tool calls and presses exclude each other too. Resolves with
// its release.
export async function lock(path: string): Promise<() => void> {
  const f = flock()
  if (!f) throw new Error('no flock in this runtime, so the button record cannot be locked')
  let fd: number
  try {
    fd = openSync(path, 'r+')
  } catch {
    fd = openSync(path, 'a', 0o600)
  }
  try {
    while (f(fd, LOCK_EX | LOCK_NB) !== 0) await Bun.sleep(LOCK_RETRY_MS)
  } catch (err) {
    closeSync(fd)
    throw err
  }
  let released = false
  return () => {
    if (released) return
    released = true
    closeSync(fd)
  }
}

// The record as a lock holder sees it: each read takes the file as it is now,
// and each update re-reads it, changes it and replaces it through a temporary
// file of its own.
export type Held = {
  read(): ButtonRecord
  update<T>(change: (rec: ButtonRecord) => T): T
}

export function createButtonStore(opts: { file: string; lockFile: string; now?: () => number; log?: (line: string) => void }) {
  const now = opts.now ?? Date.now
  const log = opts.log ?? (() => {})
  const read = (): ButtonRecord => {
    let raw: string
    try {
      raw = readFileSync(opts.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { next: now(), entries: [] }
      throw err
    }
    try {
      const parsed = JSON.parse(raw) as ButtonRecord
      if (Number.isSafeInteger(parsed?.next) && Array.isArray(parsed.entries) && parsed.entries.every(validEntry)) return parsed
    } catch {}
    try {
      renameSync(opts.file, `${opts.file}.corrupt-${Date.now()}`)
    } catch {}
    log('buttons.json is unreadable, moved aside. Starting fresh.')
    return { next: now(), entries: [] }
  }
  const write = (rec: ButtonRecord): void => {
    const tmp = `${opts.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(rec) + '\n', { mode: 0o600 })
      renameSync(tmp, opts.file)
    } catch (err) {
      try { rmSync(tmp, { force: true }) } catch {}
      throw err
    }
  }
  const held: Held = {
    read,
    update(change) {
      const rec = read()
      const result = change(rec)
      write(rec)
      return result
    },
  }
  return {
    // The record as it stands, read without the lock and changing nothing;
    // undefined when it cannot be read.
    peek(): ButtonRecord | undefined {
      try {
        const parsed = JSON.parse(readFileSync(opts.file, 'utf8')) as ButtonRecord
        return Number.isSafeInteger(parsed?.next) && Array.isArray(parsed.entries) && parsed.entries.every(validEntry) ? parsed : undefined
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { next: now(), entries: [] } : undefined
      }
    },
    async withLock<T>(fn: (held: Held) => Promise<T> | T): Promise<T> {
      const release = await lock(opts.lockFile)
      try {
        return await fn(held)
      } finally {
        release()
      }
    },
  }
}

// The event a press delivers: the label, the message's id and opening words,
// the presser, and the time the server got it.
export function pressEvent(p: {
  chat_id: string
  message_id: number
  label: string
  from: { id: number; username?: string }
  words?: string
  at: number
}): Inbound {
  // As reply_to_text does; a label that passed labelProblem comes back unchanged.
  const button = metaText(p.label, MAX_LABEL)
  return {
    content: `Pressed "${button}" on message ${p.message_id}${p.words ? `: "${p.words}"` : ''}`,
    meta: {
      chat_id: p.chat_id,
      message_id: String(p.message_id),
      button,
      user: p.from.username ?? String(p.from.id),
      user_id: String(p.from.id),
      ts: new Date(p.at).toISOString(),
    },
  }
}
