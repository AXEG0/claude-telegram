// Flood control and the call record. One watch on every Bot API call. It hands
// each call but a poll to the record, as one line: the method, the chat, how
// long it took, whether Telegram accepted it, refused it or never answered,
// the message ids, the silent flag, and Telegram's code and wait on a refusal
// or the error's name when no answer came. Never a text, a file, Telegram's
// wording or an error's message.
//
// When Telegram refuses a call with 429 it may say how many seconds to wait
// before the request can be repeated (retry_after, given "in case of exceeding
// flood control"). The watch writes a line to the log for each 429, naming the
// call, the chat and the wait, so a wait leaves a trace whichever call met it.
// A 429 with retry_after on a call that names a chat also holds that chat
// until the wait ends.
//
// Typing and the subagents message read the hold and send nothing to a held
// chat; every other call still goes to Telegram, whose answer is the authority.
// Nothing is resent or queued here.
//
// The hold ends at the later of its current end and now plus retry_after: a
// longer wait extends it, a shorter one never shortens it, and a call that
// succeeds meanwhile does not end it. A held chat is named as the call names
// it, a @username lower-cased. The holds live in the server's memory, so a
// restart forgets them; the first call after it meets Telegram's wait again.
//
// This file carries no dependencies beyond Node's.

// The start of every line the watch writes, after the server's own prefix.
export const FLOOD_LINE = 'flood control on '

export type Holds = {
  // When the chat's hold ends, in milliseconds since the epoch; 0 when the
  // chat is not held. An expired hold is dropped here.
  until(chat: unknown): number
  // Whether the chat is held now.
  held(chat: unknown): boolean
  // Holds the chat until t, unless it is held longer already. Returns the
  // hold's end.
  hold(chat: unknown, t: number): number
}

// The name a chat is held under: as the call names it, a @username
// lower-cased; undefined for a call that names no chat.
export function chatKey(chat: unknown): string | undefined {
  if (chat === undefined || chat === null) return undefined
  const name = String(chat)
  if (name === '') return undefined
  return name.startsWith('@') ? name.toLowerCase() : name
}

export function createHolds(now: () => number = Date.now): Holds {
  const ends = new Map<string, number>()
  function until(chat: unknown): number {
    const key = chatKey(chat)
    if (key === undefined) return 0
    const end = ends.get(key)
    if (end === undefined) return 0
    if (end <= now()) {
      ends.delete(key)
      return 0
    }
    return end
  }
  return {
    until,
    held: chat => until(chat) > now(),
    hold(chat, t) {
      const key = chatKey(chat)
      if (key === undefined) return 0
      const end = Math.max(ends.get(key) ?? 0, t)
      ends.set(key, end)
      return end
    },
  }
}

type Answer = { ok: boolean; result?: unknown; error_code?: number; description?: string; parameters?: { retry_after?: unknown } }

// One call's line in the record. Every field is a number, a boolean, a method
// name, a chat id or @username, or an identifier: nothing a message holds.
export type CallLine = {
  call: string
  chat?: string
  ms: number
  ok: boolean | null
  message_id?: number
  message_ids?: number[]
  silent?: true
  error_code?: number
  retry_after?: number
  not_modified?: true
  error?: string
}

// A chat as the record writes it: a numeric id, or a @username of letters,
// digits and underscores; anything else is left out.
const CHAT_SHAPE = /^(-?\d{1,20}|@[a-z0-9_]{1,64})$/
// A method, or a part of an error's name: a plain identifier, never a message.
const IDENT = /^[A-Za-z0-9_]{1,40}$/
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined)
const ident = (v: unknown): string | undefined => (typeof v === 'string' && IDENT.test(v) ? v : undefined)
// Telegram's answer to an edit that changes nothing, as agents.ts, buttons.ts
// and rich.ts read it.
const NOT_MODIFIED = /message is not modified/i

// The thrown error's name and, for grammY's HttpError, which keeps the fetch's
// error in its error property, that error's code when it is an identifier,
// else its name, joined by a slash: HttpError/ECONNRESET. A part that is no
// identifier reads unknown.
export function errorName(err: unknown): string {
  const outer = ident((err as { name?: unknown } | null | undefined)?.name) ?? 'unknown'
  if (outer !== 'HttpError') return outer
  const inner = (err as { error?: unknown }).error as { code?: unknown; name?: unknown } | null | undefined
  const part = inner === undefined || inner === null ? undefined : ident(inner.code) ?? ident(inner.name) ?? 'unknown'
  return part === undefined ? outer : `${outer}/${part}`
}

// The line for one call: an answer Telegram gave, or what the call threw.
// Each field is written only in its shape; a value out of shape is left out.
export function callLine(method: string, payload: unknown, ms: number, outcome: { res: Answer } | { err: unknown }): CallLine {
  const p = (payload ?? {}) as { chat_id?: unknown; message_id?: unknown; disable_notification?: unknown }
  const answered = 'res' in outcome ? outcome.res : undefined
  const line: CallLine = { call: ident(method) ?? 'unknown', ms, ok: answered === undefined ? null : answered.ok === true }
  const chat = chatKey(p.chat_id)
  if (chat !== undefined && CHAT_SHAPE.test(chat)) line.chat = chat
  if (p.disable_notification === true) line.silent = true
  // A send's ids come from its answer, an album's every one in order; any
  // other call's id, accepted or not, from its payload.
  const result = answered?.ok === true ? answered.result : undefined
  if (Array.isArray(result)) {
    const ids = result.map(m => int((m as { message_id?: unknown } | null | undefined)?.message_id))
    if (ids.length && ids.every(id => id !== undefined)) line.message_ids = ids as number[]
  } else {
    const id = int((result as { message_id?: unknown } | null | undefined)?.message_id) ?? int(p.message_id)
    if (id !== undefined) line.message_id = id
  }
  if (answered !== undefined && answered.ok !== true) {
    const code = int(answered.error_code)
    if (code !== undefined) line.error_code = code
    const wait = answered.parameters?.retry_after
    if (typeof wait === 'number' && Number.isFinite(wait)) line.retry_after = wait
    if (NOT_MODIFIED.test(String(answered.description ?? ''))) line.not_modified = true
  }
  if ('err' in outcome) line.error = errorName(outcome.err)
  return line
}

// The clock time of a hold's end, in UTC.
const clockOf = (t: number) => new Date(t).toISOString().slice(11, 19)

// A grammY API transformer, installed after every other one, so it sees
// Telegram's answer as it came, before grammY turns a refusal into an error,
// and every failure of a layer inside it. It hands the answer on unchanged, or
// rethrows the very error the call threw, and never throws into the call: the
// hold and its log line run in one guard, the call's record in another, and
// each swallows its own failures.
export function floodTransformer(opts: { holds: Holds; log: (line: string) => void; record: (line: CallLine) => void; now?: () => number }) {
  const now = opts.now ?? Date.now
  function watch(method: string, payload: unknown, res: Answer): void {
    if (res.ok !== false || res.error_code !== 429) return
    const chat = chatKey((payload as { chat_id?: unknown } | undefined)?.chat_id)
    const retry = res.parameters?.retry_after
    const to = chat === undefined ? 'no chat' : `chat ${chat}`
    let wait: string
    if (typeof retry !== 'number' || !Number.isFinite(retry)) wait = 'no retry_after given, nothing held'
    else if (chat === undefined) wait = `retry after ${retry} s, nothing held`
    else wait = `retry after ${retry} s, held until ${clockOf(opts.holds.hold(chat, now() + retry * 1000))} UTC`
    opts.log(`${FLOOD_LINE}${method} to ${to}: ${res.error_code}, ${wait} (Telegram: ${res.description ?? ''})`)
  }
  return async <M extends string, P, R extends Answer>(
    prev: (method: M, payload: P, signal?: AbortSignal) => Promise<R>,
    method: M,
    payload: P,
    signal?: AbortSignal,
  ): Promise<R> => {
    const started = now()
    // A poll is left out: the heartbeat keeps the latest accepted one, and a
    // failed one prints its own line.
    const record = (outcome: { res: Answer } | { err: unknown }) => {
      if (method === 'getUpdates') return
      try {
        opts.record(callLine(method, payload, now() - started, outcome))
      } catch {}
    }
    let res: R
    try {
      res = await prev(method, payload, signal)
    } catch (err) {
      record({ err })
      throw err
    }
    try {
      watch(method, payload, res)
    } catch {}
    record({ res })
    return res
  }
}
