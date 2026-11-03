// The call record checked against what the fake Telegram answered: for each
// server, by its pid, one line in logs/calls-<pid>.jsonl for each answer the
// fake gave or failure it threw (answers.jsonl, written by
// telegram-preload.ts), matched by method, chat, outcome, message ids, code
// and wait. A call the fake never finished answering, and nothing aborted, has
// neither an answer nor a line.
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { chatKey } from '../flood.ts'

// The chat as the record writes it: a numeric id or a @username, else none.
const CHAT_SHAPE = /^(-?\d{1,20}|@[a-z0-9_]{1,64})$/
const int = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined)
const chatOf = (chat: unknown) => {
  const key = chatKey(chat)
  return key !== undefined && CHAT_SHAPE.test(key) ? key : undefined
}
const key = (method: string, chat: string | undefined, ok: boolean | null, ids: number[] | number | undefined, code?: number, wait?: number) =>
  JSON.stringify([method, chat ?? null, ok, ids ?? null, code ?? null, wait ?? null])

const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l))
const add = (out: Map<number, string[]>, pid: number, k: string) => { out.set(pid, [...(out.get(pid) ?? []), k]) }

// What the fake answered, per pid: an accepted call's ids from its answer,
// any other call's from its payload.
function answered(dir: string): Map<number, string[]> {
  const out = new Map<number, string[]>()
  for (const a of lines(join(dir, 'answers.jsonl'))) {
    const fromAnswer = a.ok === true ? a.message_ids ?? a.message_id : undefined
    add(out, a.pid, key(a.method, chatOf(a.payload?.chat_id), a.ok, fromAnswer ?? int(a.payload?.message_id), a.error_code, a.retry_after))
  }
  return out
}

// What the plugin recorded, per pid, from every call file and its .1.
function recorded(dir: string): Map<number, string[]> {
  const out = new Map<number, string[]>()
  const logs = join(dir, 'logs')
  if (!existsSync(logs)) return out
  for (const name of readdirSync(logs).filter(n => /^calls-\d+\.jsonl(\.1)?$/.test(n))) {
    for (const l of lines(join(logs, name))) add(out, l.pid, key(l.call, l.chat, l.ok, l.message_ids ?? l.message_id, l.error_code, l.retry_after))
  }
  return out
}

// Each difference, per pid: an answer with no line, and a line with no
// answer. A folder is compared only where a server ran on the fake (its
// answers file is there) and the plugin could write (logs is a folder, or not
// there yet); a test that plants a file at logs asserts its own outcome.
export function callLogDiff(dir: string): string[] {
  if (!existsSync(join(dir, 'answers.jsonl'))) return []
  if (existsSync(join(dir, 'logs')) && !statSync(join(dir, 'logs')).isDirectory()) return []
  const want = answered(dir)
  const got = recorded(dir)
  const diffs: string[] = []
  for (const pid of new Set([...want.keys(), ...got.keys()])) {
    const left = [...(got.get(pid) ?? [])]
    for (const k of want.get(pid) ?? []) {
      const i = left.indexOf(k)
      if (i >= 0) left.splice(i, 1)
      else diffs.push(`pid ${pid}: no line for ${k}`)
    }
    for (const k of left) diffs.push(`pid ${pid}: line with no answer ${k}`)
  }
  return diffs
}
