// Main-session transcripts recorded from Claude Code 2.1.311 throwaway sessions
// run against a stand-in model server and a stand-in channel server named
// telegram, in fixtures/transcripts/. Every line keeps its place. The prompts,
// replies, API-error entries, queued messages and compaction entries keep the
// fields the failure notice reads, with neutral ids and links, chat ids made
// single digits, the stand-in's answers renamed and the compaction summary's
// text left out; every other line keeps only its type and time. The four drawn
// from one recording, merged-starts, merged-starts-no-position,
// two-close-failures and absorbed-into-earlier-turn, are stamped five minutes
// earlier than recorded, every line alike.
//
// - start-absorbed-own-turns: chat 1's turn fails; chat 1's next turn takes in
//   chat 2's message at a tool call and fails; then chat 1's own turn and chat
//   3's own turn fail.
// - queued-alone: after /clear, chat 1's turn ends clean, and chat 3's message,
//   queued behind it, runs as its own turn, which fails.
// - merged-starts: chat 1's turn ends clean; chats 2 and 3, queued behind it,
//   run as one turn, two prompts with one turn index, which fails; then chat
//   1's turn takes in chat 5's message at a tool call and ends clean.
// - merged-starts-no-position: merged-starts up to its failure, with the turn
//   position taken off the two merged prompts.
// - absorbed-into-earlier-turn: merged-starts with chat 9's message spliced
//   into chat 1's first, clean turn.
// - two-close-failures: chat 1's and chat 3's turns, each ending on an API
//   error, 60 ms apart, spliced from merged-starts' entries.
// - mid-turn-compaction: chat 4's turn ends clean; chat 1's turn takes in chat
//   5's message at a tool call, compacts and fails; then chat 1's own turn and
//   chat 2's own turn fail.
// - queued-behind-failing: after /clear, chat 1's turn fails after 12 s, and
//   chat 2's message, sent meanwhile, runs as its own turn, which fails.
// - scheduled-start: chat 7's and chat 8's turns end clean, then a scheduled
//   task's turn fails; its prompt has a turn origin and no origin.
// - scheduled-start-no-position: the same, with the turn position taken off
//   the scheduled task's prompt.
// - refusals: chat 1's and chat 2's turns each end on the safety classifier's
//   refusal, the first one's entries written out of order; chat 3's refused
//   reply recovers; a typed /probe command fails; chat 5's turn takes in chat
//   6's message at a tool call and fails.
// - typed-and-task-turns: typed prompts, one turn ending clean and one
//   failing; a typed turn that starts a background agent; then that agent's
//   task notification starts a turn of its own.
import { appendFileSync, readFileSync } from 'fs'
import { join } from 'path'

export type Line = Record<string, any>

export function recorded(name: string): Line[] {
  return readFileSync(join(import.meta.dir, 'transcripts', `${name}.jsonl`), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line))
}

// Lines 1 to `last`, counted from 1 as an editor counts them.
export const upTo = (lines: Line[], last: number) => lines.slice(0, last)

export const text = (line: Line): string => {
  const c = line.message?.content
  return typeof c === 'string' ? c : (c ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
}

// The lines moved in time so the line at `index` (counted from 1) is stamped
// `at`: every timestamp, a queued message's own included, shifts by the same
// amount.
export function restamp(lines: Line[], index: number, at: number): Line[] {
  const delta = at - Date.parse(lines[index - 1]!.timestamp)
  const shift = (v: any): any => {
    if (Array.isArray(v)) return v.map(shift)
    if (!v || typeof v !== 'object') return v
    const out: Line = {}
    for (const [k, x] of Object.entries(v)) {
      out[k] = k === 'timestamp' && typeof x === 'string' && !Number.isNaN(Date.parse(x))
        ? new Date(Date.parse(x) + delta).toISOString() : shift(x)
    }
    return out
  }
  return lines.map(shift)
}

export const jsonl = (lines: Line[]) => lines.map(l => JSON.stringify(l) + '\n').join('')
export const append = (file: string, lines: Line[]) => appendFileSync(file, jsonl(lines))

// New lines in the recorded shapes: a Telegram message's prompt, a reply and
// an API-error entry, from merged-starts' lines 7, 23 and 31.
const shapes = recorded('merged-starts')
const iso = (t: number) => new Date(t).toISOString()

export function prompt(uuid: string, t: number, chat: string, turn: number): Line {
  const p = structuredClone(shapes[6]!)
  return {
    ...p, uuid, timestamp: iso(t), turnPosition: { promptIndex: 0, turnIndex: turn },
    message: { ...p.message, content: p.message.content.replace(/chat_id="1"/, `chat_id="${chat}"`).replace(/user_id="1"/, `user_id="${chat}"`) },
  }
}

export function reply(uuid: string, t: number, said: string, id = `msg-${uuid}`): Line {
  const r = structuredClone(shapes[22]!)
  return { ...r, uuid, timestamp: iso(t), message: { ...r.message, id, content: [{ type: 'text', text: said }] } }
}

export function apiError(uuid: string, t: number, said: string, error = 'unknown'): Line {
  const e = structuredClone(shapes[30]!)
  return { ...e, uuid, timestamp: iso(t), error, message: { ...e.message, id: `msg-${uuid}`, content: [{ type: 'text', text: said }] } }
}

// Claude Code's text for the recorded 402.
export const CREDITS = 'API Error: 402 Insufficient credits. Add more credits to continue.'
