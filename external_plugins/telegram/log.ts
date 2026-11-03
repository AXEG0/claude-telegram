// The server's own log: every line the server prints to stderr also lands in
// logs/server-<pid>.jsonl in the state folder, since Claude Code keeps a
// server's stderr only until it connects. Beside it, logs/calls-<pid>.jsonl
// holds the record of every Bot API call but a poll (see flood.ts), written by
// logCall and never to stderr. Nothing happens at import.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'fs'
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
