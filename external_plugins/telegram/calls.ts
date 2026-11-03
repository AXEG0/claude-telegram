#!/usr/bin/env bun
// What this bot sent before its latest block: reads the call record in
// <state folder>/logs (calls-<pid>.jsonl and their .1, see flood.ts and
// log.ts), lists every hold Telegram put on a chat, and prints the hours
// before the block's first refusal. It reads only, writes nothing, calls
// nothing, and prints to stdout alone, a usage error included. Node's
// built-ins only, so it runs with no install.
//
//   bun calls.ts [--state <folder>] [--chat <id or @name>]... [--to <UTC time>] [--hours <n>]
import { readdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type Line = {
  at: string; t: number; pid: number; file: string; call: string; chat?: string; ok: boolean | null
  message_id?: number; message_ids?: number[]; silent?: true; error_code?: number; retry_after?: number
  not_modified?: true; error?: string; lost?: number
}
// One hold: a chain of 429s with a wait in one chat, each coming before the
// chain's latest end.
export type Hold = { chat: string; first: Line; end: number; longest: number; refusals: Line[] }
// A hold whose longest wait runs past this many seconds is a block.
export const BLOCK_S = 300
const HOUR_MS = 3600_000
// The earliest time a Date holds.
const EARLIEST = -8.64e15

type FileInfo = { name: string; first?: string; last?: string; lines: number; unreadable?: true }

export function readLines(dir: string): { lines: Line[]; files: FileInfo[]; skipped: number; lost: number } {
  const logs = join(dir, 'logs')
  let names: string[] = []
  const files: FileInfo[] = []
  try {
    names = readdirSync(logs).filter(n => /^calls-\d+\.jsonl(\.1)?$/.test(n)).sort()
  } catch (err) {
    if ((err as { code?: unknown }).code !== 'ENOENT') files.push({ name: 'logs', lines: 0, unreadable: true })
  }
  const lines: Line[] = []
  let skipped = 0
  let lost = 0
  for (const name of names) {
    let n = 0
    let first: string | undefined
    let last: string | undefined
    // A file that cannot be read, such as one rotated or swept between the
    // listing and the read, is listed as unreadable and skipped.
    let body: string
    try { body = readFileSync(join(logs, name), 'utf8') } catch { files.push({ name, lines: 0, unreadable: true }); continue }
    for (const text of body.split('\n')) {
      if (!text.trim()) continue
      // A line that does not parse, such as one a crash cut short, is
      // counted and skipped, and the lines after it are read.
      let l: Line
      try { l = JSON.parse(text) } catch { skipped++; continue }
      const t = typeof l?.at === 'string' ? Date.parse(l.at) : NaN
      if (!Number.isFinite(t) || typeof l.call !== 'string') { skipped++; continue }
      lines.push({ ...l, t, file: name })
      if (typeof l.lost === 'number' && Number.isFinite(l.lost)) lost += l.lost
      first ??= l.at
      last = l.at
      n++
    }
    files.push({ name, first, last, lines: n })
  }
  lines.sort((a, b) => a.t - b.t)
  return { lines, files, skipped, lost }
}

// Each chat's 429s that carry a wait, chained: a refusal that comes before the
// chain's latest end joins it.
export function holdsOf(lines: Line[]): Hold[] {
  const open = new Map<string, Hold>()
  const all: Hold[] = []
  for (const l of lines) {
    if (l.ok !== false || l.error_code !== 429 || typeof l.retry_after !== 'number' || !Number.isFinite(l.retry_after)) continue
    const chat = l.chat ?? 'no chat'
    const end = l.t + l.retry_after * 1000
    const h = open.get(chat)
    if (h && l.t <= h.end) {
      h.end = Math.max(h.end, end)
      h.longest = Math.max(h.longest, l.retry_after)
      h.refusals.push(l)
    } else {
      const fresh = { chat, first: l, end, longest: l.retry_after, refusals: [l] }
      open.set(chat, fresh)
      all.push(fresh)
    }
  }
  return all
}

// Among the holds in the chats given, or in any chat: the one whose first
// refusal is latest among those whose longest wait ran past BLOCK_S; with
// none, the latest hold.
export function pickHold(holds: Hold[], chats: string[]): Hold | undefined {
  const mine = holds.filter(h => !chats.length || chats.includes(h.chat))
  const long = mine.filter(h => h.longest > BLOCK_S)
  return (long.length ? long : mine).at(-1)
}

const iso = (t: number) => new Date(t).toISOString().replace('.000Z', 'Z')

// The report, in UTC. With no --to, the window ends at the picked block's
// first refusal, or now when no call met a 429.
export function report(dir: string, o: { chats?: string[]; to?: number; hours?: number } = {}): string {
  const out: string[] = []
  const given = o.chats ?? []
  const { lines, files, skipped, lost } = readLines(dir)
  out.push(`state folder: ${dir}`)
  for (const f of files) out.push(f.unreadable ? `  ${f.name}: unreadable, skipped` : `  ${f.name}: ${f.lines} lines, ${f.first ?? '-'} to ${f.last ?? '-'}`)
  out.push(`  lines skipped: ${skipped}; lines lost: ${lost}`)
  const holds = holdsOf(lines)
  out.push('holds:')
  for (const h of holds) out.push(`  chat ${h.chat}: from ${h.first.at} to ${iso(h.end)}, longest wait ${h.longest} s, ${h.refusals.length} refusals`)
  if (!holds.length) out.push('  none')
  const picked = o.to === undefined ? pickHold(holds, given) : undefined
  const to = o.to ?? picked?.first.t ?? Date.now()
  const from = Math.max(to - (o.hours ?? 24) * HOUR_MS, EARLIEST)
  if (picked) out.push(`block: chat ${picked.chat}, first refusal ${picked.first.at} (${picked.first.call}, wait ${picked.first.retry_after} s, ends ${iso(picked.first.t + picked.first.retry_after! * 1000)}), lifts ${iso(picked.end)}`)
  const chats = given.length ? given : picked ? [picked.chat] : undefined
  out.push(`window: ${iso(from)} to ${iso(to)}${chats ? `, chat ${chats.join(', ')}` : ', every chat'}`)
  // A rotated process keeps only its .1 and its live file: a .1 that starts
  // after the window's start means its earlier lines are gone.
  for (const f of files.filter(f => f.name.endsWith('.1'))) {
    if (f.first && Date.parse(f.first) > from) out.push(`  warning: ${f.name.slice(0, -2)} rotated; its kept lines start ${f.first}, after the window's start`)
  }
  const inChats = (l: Line) => !chats || (l.chat !== undefined && chats.includes(l.chat))
  const inWindow = lines.filter(l => l.t >= from && l.t < to && inChats(l))
  // The subagents list's messages: those its silent sends got, by chat and id.
  const listMessages = new Set(lines.filter(l => l.silent && l.ok === true && l.message_id !== undefined).map(l => `${l.chat}/${l.message_id}`))
  const kind = (l: Line) => l.call === 'editMessageText' ? (listMessages.has(`${l.chat}/${l.message_id}`) ? 'editMessageText (list)' : 'editMessageText (other)') : l.call
  const per = new Map<string, { ok: number; refused: Map<string, number>; none: number }>()
  for (const l of inWindow) {
    const k = kind(l)
    const c = per.get(k) ?? { ok: 0, refused: new Map(), none: 0 }
    if (l.ok === true) c.ok++
    else if (l.ok === false) { const r = l.not_modified ? '400 not modified' : String(l.error_code ?? '?'); c.refused.set(r, (c.refused.get(r) ?? 0) + 1) }
    else c.none++
    per.set(k, c)
  }
  out.push('per call: accepted, refused by code, no answer')
  for (const [k, c] of [...per].sort()) out.push(`  ${k}: ${c.ok} accepted, ${[...c.refused].map(([r, n]) => `${n} ${r}`).join(', ') || '0 refused'}, ${c.none} no answer`)
  if (chats) {
    // Totals outside the chats read: other chats, and calls naming none.
    const outside = lines.filter(l => l.t >= from && l.t < to && !inChats(l))
    const tally = (ls: Line[]) => `${ls.length} calls, ${ls.filter(l => l.ok === true).length} accepted, ${ls.filter(l => l.ok === false).length} refused, ${ls.filter(l => l.ok === null).length} no answer`
    out.push(`  other chats: ${tally(outside.filter(l => l.chat !== undefined))}`)
    out.push(`  no chat: ${tally(outside.filter(l => l.chat === undefined))}`)
  }
  out.push('per UTC hour:')
  const hourly = new Map<string, Map<string, number>>()
  for (const l of inWindow) {
    const h = `${new Date(l.t).toISOString().slice(0, 13)}:00Z`
    const m = hourly.get(h) ?? new Map()
    m.set(kind(l), (m.get(kind(l)) ?? 0) + 1)
    hourly.set(h, m)
  }
  for (const [h, m] of hourly) out.push(`  ${h}: ${[...m].map(([k, n]) => `${k} ${n}`).join(', ')}`)
  if (inWindow.length) out.push(`first call in the window: ${inWindow[0]!.at} ${kind(inWindow[0]!)}`)
  out.push('last calls before the end:')
  for (const l of inWindow.slice(-20)) out.push(`  ${l.at} ${kind(l)} ${l.ok === true ? 'ok' : l.ok === false ? `refused ${l.error_code}${l.retry_after !== undefined ? ` wait ${l.retry_after}` : ''}` : `no answer ${l.error ?? ''}`}`)
  return out.join('\n') + '\n'
}

// A time given with no zone is UTC, never the machine's own zone: a date, or a
// date and time with T or a space between them, and a zone only as Z or
// +hh:mm. Anything else is no time (the usage line).
const TIME = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:\d{2})?)?$/i
const utc = (v: string) => {
  const m = TIME.exec(v)
  return m ? (m[2] ? `${m[1]}T${m[2]}${(m[3] ?? 'Z').toUpperCase()}` : m[1]) : 'no time'
}
// A day past its month's end, such as 2026-02-30, is no date: Date.parse rolls
// it over into the next month, so it gets the usage line too.
const realDay = (v: string) => {
  const d = TIME.exec(v)?.[1]
  const t = d === undefined ? NaN : Date.parse(`${d}T00:00:00Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d
}

const USAGE = 'usage: bun calls.ts [--state <folder>] [--chat <id or @name>]... [--to <UTC time>] [--hours <n>]\n'

if (import.meta.main) {
  const args = process.argv.slice(2)
  const chats: string[] = []
  let dir = process.env.TELEGRAM_STATE_DIR ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'channels', 'telegram')
  let to: number | undefined
  let hours: number | undefined
  for (let i = 0; i < args.length; i++) {
    const v = args[i + 1]
    if (args[i] === '--state' && v) { dir = v; i++ }
    else if (args[i] === '--chat' && v) { chats.push(v.startsWith('@') ? v.toLowerCase() : v); i++ }
    else if (args[i] === '--to' && v && realDay(v) && Number.isFinite(Date.parse(utc(v)))) { to = Date.parse(utc(v)); i++ }
    else if (args[i] === '--hours' && v && Number.isFinite(Number(v)) && Number(v) > 0) { hours = Number(v); i++ }
    else { process.stdout.write(USAGE); process.exit(1) }
  }
  process.stdout.write(report(dir, { chats, to, hours }))
}
