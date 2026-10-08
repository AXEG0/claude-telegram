// Streams Claude Code's subagents to Telegram, one message per subagent that
// is edited while it runs, the way the CLI shows them:
//
//   🤖 general-purpose · Review claude-telegram PRs 3 and 4
//   ⏳ Checking gate mention and server env · 4m 31s · 85.4k tokens
//
// The plugin's SubagentStart and SubagentStop hook (hooks/subagent.ts)
// appends one line per event to a file named for the Claude Code pid. The
// server reads the files of its ancestors, then follows each subagent's own
// transcript for its current step and token count, and its meta file for its
// description.
//
// This file carries no dependencies beyond Node's, so the hook can import it
// before `bun install` has run.

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'fs'
import { join } from 'path'

export const AGENT_TICK_MS = 3000
// Telegram limits messages per chat, so all subagents in a chat share one
// budget: one send or edit per this gap.
export const CHAT_GAP_MS = 3000
// With no new step or token count, a message is edited only this often, to
// move its clock.
export const CLOCK_REFRESH_MS = 10_000
// A subagent whose transcript has not changed for this long is shown as quiet;
// its stop still closes it.
export const AGENT_STALE_MS = 30 * 60 * 1000
// After this long quiet, a subagent is dropped without a stop.
export const AGENT_DROP_MS = 2 * 60 * 60 * 1000
const TAIL_BYTES = 256 * 1024

export type AgentEvent = {
  t: number
  event: 'start' | 'stop'
  agent_id: string
  agent_type?: string
  // <session transcript dir>/<session id>/subagents/agent-<id>, without suffix.
  agent_base?: string
}

export function agentEventFile(dir: string, pid: number): string {
  return join(dir, 'agents', `pid-${pid}.jsonl`)
}

export function appendAgentEvent(file: string, ev: AgentEvent): void {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
  appendFileSync(file, JSON.stringify(ev) + '\n')
}

// Hook input → event. The subagent's files sit beside the session transcript,
// in a directory named for the session.
export function eventFromHook(input: {
  hook_event_name?: string
  agent_id?: string
  agent_type?: string
  transcript_path?: string
}, now: number = Date.now()): AgentEvent | undefined {
  const event = input.hook_event_name === 'SubagentStart' ? 'start'
    : input.hook_event_name === 'SubagentStop' ? 'stop' : undefined
  if (!event || !input.agent_id || !/^[\w-]+$/.test(input.agent_id)) return undefined
  const tp = input.transcript_path
  // A nested subagent's hook may name its parent subagent's transcript, which
  // already sits in the session's flat subagents directory.
  const base = !tp?.endsWith('.jsonl') ? undefined
    : /[\\/]subagents[\\/]agent-[^\\/]+\.jsonl$/.test(tp) ? join(tp, '..', `agent-${input.agent_id}`)
    : join(tp.slice(0, -'.jsonl'.length), 'subagents', `agent-${input.agent_id}`)
  return { t: now, event, agent_id: input.agent_id, agent_type: input.agent_type, agent_base: base }
}

// Reads what was appended to each file since the last call.
export function createEventReader(files: string[], fromNow = true) {
  const offsets = new Map<string, number>()
  for (const f of files) {
    let size = 0
    try { size = statSync(f).size } catch {}
    offsets.set(f, fromNow ? size : 0)
  }
  return (): AgentEvent[] => {
    const out: AgentEvent[] = []
    for (const f of files) {
      let size: number
      try { size = statSync(f).size } catch { continue }
      let off = offsets.get(f) ?? 0
      if (size < off) off = 0
      if (size === off) continue
      const text = readRange(f, off, size)
      const end = text.lastIndexOf('\n')
      if (end < 0) continue
      offsets.set(f, off + Buffer.byteLength(text.slice(0, end + 1)))
      for (const line of text.slice(0, end).split('\n')) {
        try {
          const ev = JSON.parse(line) as AgentEvent
          if (ev.agent_id && (ev.event === 'start' || ev.event === 'stop')) out.push(ev)
        } catch {}
      }
    }
    return out
  }
}

function readRange(file: string, from: number, to: number): string {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(to - from)
    readSync(fd, buf, 0, buf.length, from)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export type Progress = { step?: string; tokens?: number; updatedAt?: number }

export const THINKING = '💭 Thinking…'
export const WRITING = '✍️ Writing…'

// The current step and context size from the end of a subagent transcript.
// The step is the running tool call's description, or its tool and target;
// thinking once a tool has returned or the model only thinks; writing once it
// produces text. The size is the last request's input plus output tokens,
// which is what the CLI shows.
export function progressFromTranscript(text: string): Progress {
  const lines = text.split('\n')
  const p: Progress = {}
  for (let i = lines.length - 1; i >= 0 && (p.step === undefined || p.tokens === undefined); i--) {
    const line = lines[i]!
    const isResult = line.includes('"tool_result"')
    if (!line.includes('"assistant"') && !isResult) continue
    let e: { type?: string; timestamp?: string; message?: { usage?: Record<string, number>; content?: unknown[] } }
    try { e = JSON.parse(line) } catch { continue }
    if (e.type === 'user' && isResult) {
      if (p.step === undefined) p.step = THINKING
      continue
    }
    if (e.type !== 'assistant') continue
    if (p.updatedAt === undefined && e.timestamp) p.updatedAt = Date.parse(e.timestamp)
    const u = e.message?.usage
    if (p.tokens === undefined && u) {
      p.tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
        + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
    }
    if (p.step === undefined) {
      const content = Array.isArray(e.message?.content) ? e.message!.content as Record<string, unknown>[] : []
      for (let j = content.length - 1; j >= 0; j--) {
        const c = content[j]!
        if (c.type === 'tool_use') {
          p.step = stepFor(String(c.name ?? 'tool'), (c.input ?? {}) as Record<string, unknown>)
          break
        }
      }
      if (p.step === undefined) p.step = content.some(c => c.type === 'text') ? WRITING : THINKING
    }
  }
  return p
}

// The tool call's own description when it has one. Otherwise the tool name,
// with only a file's name or a search pattern beside it: commands, URLs and
// queries can carry credentials and never leave the box.
function stepFor(tool: string, input: Record<string, unknown>): string {
  if (typeof input.description === 'string' && input.description.trim()) return oneLine(input.description)
  const file = [input.file_path, input.path, input.notebook_path].find(v => typeof v === 'string' && v.trim()) as string | undefined
  if (file) return `${tool} ${oneLine(file.split(/[\\/]/).filter(Boolean).pop() ?? '', 60)}`
  if ((tool === 'Grep' || tool === 'Glob') && typeof input.pattern === 'string') return `${tool} ${oneLine(input.pattern, 40)}`
  return tool
}

function oneLine(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s % 60}s`
  return `${s}s`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

type Agent = {
  id: string
  type: string
  base?: string
  description?: string
  chatId?: string
  started: number
  progress: Progress
  quietSince: number
  done?: number
  msgId?: number
  // The message can no longer be edited, or sending keeps failing.
  gone?: boolean
  failures: number
  sending?: boolean
  sentKey?: string
  lastEdit: number
}

export function render(a: Agent, now: number): string {
  const head = `🤖 ${a.type}${a.description ? ` · ${oneLine(a.description)}` : ''}`
  const tokens = a.progress.tokens ? ` · ${formatTokens(a.progress.tokens)} tokens` : ''
  if (a.done) return `${head}\n✅ Done in ${formatDuration(a.done - a.started)}${tokens}`
  const step = a.progress.step ?? 'Starting…'
  if (now - a.quietSince > AGENT_STALE_MS) {
    return `${head}\n⚠️ No activity for ${formatDuration(now - a.quietSince)} · last: ${step}${tokens}`
  }
  return `${head}\n⏳ ${step} · ${formatDuration(now - a.started)}${tokens}`
}

// What the message says apart from its clock.
function contentKey(a: Agent, now: number): string {
  return JSON.stringify([a.type, a.description, a.progress.step, a.progress.tokens, a.done,
    now - a.quietSince > AGENT_STALE_MS])
}

export type AgentStream = { tick(): void; agents(): Agent[] }

type ApiError = { description?: string; parameters?: { retry_after?: number } }

export function createAgentStream(opts: {
  readEvents: () => AgentEvent[]
  // The private chat to stream into, or undefined while there is none.
  chat: () => string | undefined
  send: (chatId: string, text: string) => Promise<number | undefined>
  edit: (chatId: string, msgId: number, text: string) => Promise<void>
  readFile?: (path: string) => string | undefined
  mtime?: (path: string) => number | undefined
  now?: () => number
}): AgentStream {
  const now = opts.now ?? Date.now
  const readFile = opts.readFile ?? tailOf
  const mtime = opts.mtime ?? mtimeOf
  const agents = new Map<string, Agent>()
  // Stops whose start has not been read yet: the two hooks run concurrently.
  const earlyStops = new Map<string, number>()
  const chatNext = new Map<string, number>()
  let first = true

  function refresh(a: Agent) {
    if (!a.base) return
    if (a.description === undefined) {
      try {
        const meta = JSON.parse(readFile(`${a.base}.meta.json`) ?? '') as { description?: string; agentType?: string }
        if (typeof meta.description === 'string') a.description = meta.description
        if (typeof meta.agentType === 'string' && a.type === 'agent') a.type = meta.agentType
      } catch {}
    }
    const m = mtime(`${a.base}.jsonl`)
    if (m && m > a.quietSince) {
      a.quietSince = m
      const tail = readFile(`${a.base}.jsonl`)
      if (tail) a.progress = { ...a.progress, ...definedOnly(progressFromTranscript(tail)) }
    }
  }

  function flush(a: Agent, t: number) {
    if (a.sending || a.gone || !a.chatId) return
    const key = contentKey(a, t)
    if (key === a.sentKey && (a.done || t - a.lastEdit < CLOCK_REFRESH_MS)) return
    const chatId = a.chatId
    if (t < (chatNext.get(chatId) ?? 0)) return
    chatNext.set(chatId, t + CHAT_GAP_MS)
    a.sending = true
    a.lastEdit = t
    const text = render(a, t)
    const ok = () => { a.sentKey = key; a.failures = 0 }
    const fail = (err: unknown) => {
      const e = (err ?? {}) as ApiError
      const desc = String(e.description ?? err)
      if (/message is not modified/i.test(desc)) return ok()
      a.lastEdit = 0 // retry once the chat allows, not at the next clock refresh
      const retry = e.parameters?.retry_after
      if (retry) chatNext.set(chatId, now() + retry * 1000)
      if (/message to edit not found|message can't be edited/i.test(desc) || ++a.failures >= 5) a.gone = true
    }
    const done = () => { a.sending = false }
    if (a.msgId === undefined) {
      opts.send(chatId, text).then(id => { a.msgId = id; ok() }, fail).finally(done)
    } else {
      opts.edit(chatId, a.msgId, text).then(ok, fail).finally(done)
    }
  }

  return {
    tick() {
      const t = now()
      for (const ev of opts.readEvents()) {
        if (ev.event === 'start') {
          const old = agents.get(ev.agent_id)
          if (old && !old.done) continue
          if (t - ev.t > AGENT_STALE_MS) continue
          const a: Agent = {
            id: ev.agent_id,
            type: ev.agent_type || 'agent',
            base: ev.agent_base,
            started: ev.t,
            progress: {},
            quietSince: ev.t,
            failures: 0,
            lastEdit: 0,
          }
          const stop = earlyStops.get(ev.agent_id)
          if (stop !== undefined && stop >= ev.t) a.done = stop
          earlyStops.delete(ev.agent_id)
          agents.set(ev.agent_id, a)
        } else {
          const a = agents.get(ev.agent_id)
          if (a && !a.done) a.done = ev.t
          else if (!a) earlyStops.set(ev.agent_id, ev.t)
        }
      }
      // The first read is the backlog from before this server started: only
      // subagents still running are of interest.
      if (first) {
        first = false
        for (const a of agents.values()) if (a.done) agents.delete(a.id)
        earlyStops.clear()
      }
      for (const [id, at] of earlyStops) if (t - at > 10 * 60 * 1000) earlyStops.delete(id)

      for (const a of agents.values()) {
        a.chatId ??= opts.chat()
        refresh(a)
        flush(a, t)
        const finished = a.done && !a.sending && (a.gone || !a.chatId || a.sentKey === contentKey(a, t))
        if (finished || t - a.quietSince > AGENT_DROP_MS) agents.delete(a.id)
      }
    },
    agents() {
      return [...agents.values()]
    },
  }
}

function definedOnly(p: Progress): Progress {
  const out: Progress = {}
  if (p.step !== undefined) out.step = p.step
  if (p.tokens !== undefined) out.tokens = p.tokens
  if (p.updatedAt !== undefined) out.updatedAt = p.updatedAt
  return out
}

function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

// The last TAIL_BYTES of a file, from its first whole line.
function tailOf(path: string): string | undefined {
  try {
    const size = statSync(path).size
    if (size <= TAIL_BYTES) return readFileSync(path, 'utf8')
    const text = readRange(path, size - TAIL_BYTES, size)
    return text.slice(text.indexOf('\n') + 1)
  } catch {
    return undefined
  }
}
