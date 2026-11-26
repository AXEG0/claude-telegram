// The server's own log: every line the server prints to stderr also lands in
// logs/server-<pid>.jsonl in the state folder, since Claude Code keeps a
// server's stderr only until it connects. Beside it, logs/calls-<pid>.jsonl
// holds the record of every Bot API call but a poll (see flood.ts), written by
// logCall and never to stderr, and logs/text-<time>-<pid>-<n>.jsonl the saved
// copy of the words a call sent from text_files (see createCopy). Nothing
// happens at import.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { format } from 'util'

const SERVER_BOUND = 1024 * 1024
const CALLS_BOUND = 16 * 1024 * 1024
const SHAPE = /\d{5,}:[A-Za-z0-9_-]{30,}/g

// One file per process and per kind: its own name, bound and ragged flag. Each
// record gets the envelope. A failed append is dropped and marks the file
// ragged, so the next record starts on a new line; the return says whether
// the record landed.
function appender(dir: string, name: string, bound: number, version: string) {
  const file = join(dir, name)
  let ragged = false
  return (fields: object): boolean => {
    try {
      try { mkdirSync(dir, { mode: 0o700 }) } catch {}
      appendFileSync(file, `${ragged ? '\n' : ''}${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, version, ...fields })}\n`, { mode: 0o600 })
    } catch { ragged = true; return false }
    ragged = false
    try { if (statSync(file).size > bound) renameSync(file, `${file}.1`) } catch {}
    return true
  }
}

// An Error prints as its name and message, then its stack's frames: never its
// own fields, since a grammY error's payload holds the message it tried to send.
function frames(err: Error): string[] {
  let stack: unknown
  try { stack = err.stack } catch {}
  return typeof stack === 'string' ? stack.split('\n').filter(l => /^\s+at /.test(l)) : []
}

function errorText(err: Error): string {
  let head: string
  try { head = String(err) } catch { head = 'Error' }
  return [head, ...frames(err)].join('\n')
}

// The call record's appender, made at setup; before it, a call line is
// written nowhere.
let appendCall: ((fields: object) => boolean) | undefined
// The call lines that failed to land since the last one that did.
let lost = 0

// One call's line, as the flood watch gives it. It goes to the file alone: no
// field can hold a secret, so nothing is masked. A line that lands carries how
// many before it did not, as lost.
export function logCall(line: object): void {
  if (appendCall === undefined) return
  if (appendCall(lost ? { ...line, lost } : line)) lost = 0
  else lost++
}

export function setupLog(stateDir: string): void {
  let version = 'unknown'
  try { version = String(JSON.parse(readFileSync(join(import.meta.dir, '.claude-plugin', 'plugin.json'), 'utf8')).version ?? 'unknown') } catch {}
  copiesAt = { dir: join(stateDir, 'logs'), version }
  const exact = [process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_STT_OPENAI_KEY].map(s => s?.trim()).filter((s): s is string => !!s && s.length >= 8)
  const mask = (t: string) => exact.reduce((acc, s) => acc.split(s).join('<masked>'), t).replace(SHAPE, '<masked>')
  const append = appender(join(stateDir, 'logs'), `server-${process.pid}.jsonl`, SERVER_BOUND, version)
  appendCall = appender(join(stateDir, 'logs'), `calls-${process.pid}.jsonl`, CALLS_BOUND, version)
  const decoder = new TextDecoder()
  // Once stderr's far end has gone, a line still lands in the file and skips
  // only the stderr write, so a failed write never loops through the handlers.
  let failed = false
  process.stderr.on('error', () => { failed = true })
  const raw = process.stderr.write
  ;(process.stderr as any).write = function (chunk: any, encoding?: any, cb?: any) {
    const text = mask(typeof chunk === 'string' ? chunk : decoder.decode(chunk))
    append({ log: text.replace(/\n$/, '') })
    if (typeof encoding === 'function') { cb = encoding; encoding = undefined }
    if (failed || process.stderr.destroyed) { if (cb) queueMicrotask(cb); return false }
    try { return raw.call(process.stderr, text, cb) } catch { return false }
  }
  const print = (...args: unknown[]) => {
    const parts = args.map(a => a instanceof Error ? errorText(a) : a)
    process.stderr.write(`${format(...(args[0] instanceof Error ? ['%s', ...parts] : parts))}\n`)
  }
  console.error = print
  console.warn = print
  // The process's warning printer. Bun 1.4 attaches its own as a 'warning'
  // listener, and Bun 1.3 prints only while no listener is attached, so this
  // one listener replaces the runtime's printer on both. It prints what Bun
  // 1.4's printer prints with --trace-warnings: the head, the frames, the detail.
  process.removeAllListeners('warning')
  process.on('warning', w => {
    const { code, detail } = w as { code?: unknown; detail?: unknown }
    const head = `(node:${process.pid}) ${code ? `[${code}] ` : ''}${errorText(w)}`
    process.stderr.write(`${head}${typeof detail === 'string' ? `\n${detail}` : ''}\n`)
  })
}

// The saved copies of the words sent. A reply or edit_message whose text comes
// from text_files writes logs/text-<time>-<pid>-<n>.jsonl: <time> when the call
// began, in UTC, as 20261110T091500123Z, the server's pid, and the call's
// number in this process, so no two calls share a file. It holds one line for
// each message Telegram accepted, or may have, with the envelope every log
// line carries, the tool, the chat, the message id, the Telegram method, and
// the text exactly as that call carried it, under the payload's own name:
// text (with parse_mode when one is set), markdown for a rich message, or
// caption. The chat is the one Telegram's answer names, where it names one,
// else the one the call asked for. A send whose outcome is unknown is marked
// delivery "unknown", with no message id, since Telegram gave none. Unlike the
// server log and the call record, a copy holds message text, nothing masked,
// so it takes the folder's owner-only rule. A call's first line first puts
// the server log's line for the call, naming its files and the copy's path,
// never the text, so the log names a copy exactly when a message went or may
// have, whether or not the copy can be written; once written, it deletes the
// oldest other copies until all of them fit in COPIES_MAX; the turn-end hook's
// week-old sweep of logs/ takes the rest. A line that cannot be written never
// stops the call: the answer says the words were not saved, and why.
export const COPIES_MAX = 64 * 1024 * 1024
const COPY_NAME = /^text-\d{8}T\d{9}Z-\d+-\d+\.jsonl$/
let copiesAt: { dir: string; version: string } | undefined
let copiesMade = 0

export type CopyLine = {
  method: string
  chat?: string
  message_id?: number
  delivery?: 'unknown'
  text?: string
  markdown?: string
  caption?: string
  parse_mode?: string
}
export type Copy = {
  path: string
  line(fields: CopyLine): void
  // What the call's answer says of its copy: its path; that the words, or
  // some of them, were not saved, and why; or nothing, when no message went.
  note(): string
}

// A copy for a call to chat that began at began, its text from the files
// files names (their paths, sizes and sha256s).
export function createCopy(tool: string, chat: string, began: Date, files: string): Copy {
  const at = copiesAt
  const name = `text-${began.toISOString().replace(/[-:.]/g, '')}-${process.pid}-${++copiesMade}.jsonl`
  const path = at ? join(at.dir, name) : name
  let lines = 0
  let failed: string | undefined
  let ragged = false
  let logged = false
  return {
    path,
    line(fields) {
      if (!logged) {
        logged = true
        process.stderr.write(`telegram channel: ${tool} to chat ${chat}: text from ${files}; its copy: ${path}\n`)
      }
      try {
        if (!at) throw new Error('the server log was never set up')
        try { mkdirSync(at.dir, { mode: 0o700 }) } catch {}
        appendFileSync(path, `${ragged ? '\n' : ''}${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, version: at.version, tool, chat, ...fields })}\n`, { mode: 0o600 })
      } catch (err) {
        ragged = true
        if (failed === undefined) {
          failed = err instanceof Error ? err.message : String(err)
          process.stderr.write(`telegram channel: not all of the words sent were saved in ${path}: ${failed}\n`)
        }
        return
      }
      ragged = false
      if (lines++ === 0) pruneCopies(at!.dir, name)
    },
    note() {
      if (failed === undefined) return lines ? `; the words sent are saved in ${path}` : ''
      return lines
        ? `; the words sent are saved in ${path}, but not all of them: ${failed}`
        : `; the words sent were not saved: ${failed}`
    },
  }
}

// Deletes the oldest copies but the one named keep until all of them fit in
// COPIES_MAX. Several servers share the folder, so a copy gone meanwhile is
// skipped.
function pruneCopies(dir: string, keep: string): void {
  let names: string[]
  try { names = readdirSync(dir).filter(n => COPY_NAME.test(n)) } catch { return }
  const copies = names.flatMap(n => {
    try {
      const st = statSync(join(dir, n))
      return [{ n, size: st.size, mtime: st.mtimeMs }]
    } catch { return [] }
  })
  let total = copies.reduce((sum, c) => sum + c.size, 0)
  const oldest = copies.filter(c => c.n !== keep).sort((a, b) => a.mtime - b.mtime || (a.n < b.n ? -1 : 1))
  for (const c of oldest) {
    if (total <= COPIES_MAX) break
    try { rmSync(join(dir, c.n), { force: true }) } catch {}
    total -= c.size
  }
}
