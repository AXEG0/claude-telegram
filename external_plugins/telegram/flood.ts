// Flood control. When Telegram refuses a call with 429 it may say how many
// seconds to wait before the request can be repeated (retry_after, given "in
// case of exceeding flood control"). One watch on every Bot API call writes a
// line to the log for each 429, naming the call, the chat and the wait, so a
// wait leaves a trace whichever call met it. A 429 with retry_after on a call
// that names a chat also holds that chat until the wait ends.
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

type Answer = { ok: boolean; error_code?: number; description?: string; parameters?: { retry_after?: unknown } }

// The clock time of a hold's end, in UTC.
const clockOf = (t: number) => new Date(t).toISOString().slice(11, 19)

// A grammY API transformer, installed after every other one, so it sees
// Telegram's answer as it came, before grammY turns a refusal into an error.
// It hands the answer on unchanged and never throws into the call: its record
// and its log write run inside a guard that swallows their own failures.
export function floodTransformer(opts: { holds: Holds; log: (line: string) => void; now?: () => number }) {
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
    const res = await prev(method, payload, signal)
    try {
      watch(method, payload, res)
    } catch {}
    return res
  }
}
