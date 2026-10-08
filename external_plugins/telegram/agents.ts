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
// Telegram limits edits per chat; one edit per subagent at most this often.
export const AGENT_EDIT_MS = 5000
// A subagent whose stop never arrives, and whose transcript stops growing,
// is closed after this long.
export const AGENT_STALE_MS = 30 * 60 * 1000
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
  const base = input.transcript_path?.endsWith('.jsonl')
    ? join(input.transcript_path.slice(0, -'.jsonl'.length), 'subagents', `agent-${input.agent_id}`)
    : undefined
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

// The current step and context size from the end of a subagent transcript:
// the last tool call's description, or its tool and target, and the last
// request's input plus output tokens, which is what the CLI shows.
export function progressFromTranscript(text: string): Progress {
  const lines = text.split('\n')
  const p: Progress = {}
  for (let i = lines.length - 1; i >= 0 && (p.step === undefined || p.tokens === undefined); i--) {
    const line = lines[i]!
    if (!line.includes('"assistant"')) continue
    let e: { type?: string; timestamp?: string; message?: { usage?: Record<string, number>; content?: unknown[] } }
    try { e = JSON.parse(line) } catch { continue }
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
    }
  }
  return p
}

function stepFor(tool: string, input: Record<string, unknown>): string {
  if (typeof input.description === 'string' && input.description.trim()) return oneLine(input.description)
  const target = ['file_path', 'path', 'pattern', 'url', 'query', 'command']
    .map(k => input[k])
    .find(v => typeof v === 'string' && v.trim()) as string | undefined
  if (!target) return tool
  const short = target.includes('/') && !target.includes(' ') ? target.split('/').filter(Boolean).pop() ?? target : target
  return `${tool} ${oneLine(short)}`
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
  chatId: string
  started: number
  progress: Progress
  done?: number
  msgId?: number
  sending?: boolean
  sentText?: string
  lastEdit: number
}

export function render(a: Agent, now: number): string {
  const head = `🤖 ${a.type}${a.description ? ` · ${oneLine(a.description)}` : ''}`
  const tokens = a.progress.tokens ? ` · ${formatTokens(a.progress.tokens)} tokens` : ''
  if (a.done) return `${head}\n✅ Done in ${formatDuration(a.done - a.started)}${tokens}`
  return `${head}\n⏳ ${a.progress.step ?? 'Starting…'} · ${formatDuration(now - a.started)}${tokens}`
}

export type AgentStream = { tick(): void; agents(): Agent[] }

export function createAgentStream(opts: {
  readEvents: () => AgentEvent[]
  // The private chat to stream into, or undefined to stream nothing.
  chat: () => string | undefined
  send: (chatId: string, text: string) => Promise<number | undefined>
  edit: (chatId: string, msgId: number, text: string) => Promise<void>
  readFile?: (path: string) => string | undefined
  now?: () => number
}): AgentStream {
  const now = opts.now ?? Date.now
  const readFile = opts.readFile ?? tailOf
  const agents = new Map<string, Agent>()

  function refresh(a: Agent) {
    if (!a.base) return
    if (a.description === undefined) {
      try {
        const meta = JSON.parse(readFile(`${a.base}.meta.json`) ?? '') as { description?: string; agentType?: string }
        if (typeof meta.description === 'string') a.description = meta.description
        if (typeof meta.agentType === 'string' && a.type === 'agent') a.type = meta.agentType
      } catch {}
    }
    const tail = readFile(`${a.base}.jsonl`)
    if (tail) a.progress = { ...a.progress, ...definedOnly(progressFromTranscript(tail)) }
  }

  function flush(a: Agent, t: number) {
    if (a.sending) return
    const text = render(a, t)
    if (text === a.sentText) return
    if (!a.done && a.msgId !== undefined && t - a.lastEdit < AGENT_EDIT_MS) return
    a.sending = true
    a.lastEdit = t
    const finish = () => { a.sending = false }
    if (a.msgId === undefined) {
      opts.send(a.chatId, text)
        .then(id => { a.msgId = id; a.sentText = text })
        .catch(() => {})
        .finally(finish)
    } else {
      opts.edit(a.chatId, a.msgId, text)
        .then(() => { a.sentText = text })
        .catch(() => {})
        .finally(finish)
    }
  }

  return {
    tick() {
      const t = now()
      for (const ev of opts.readEvents()) {
        if (ev.event === 'start') {
          const chatId = opts.chat()
          if (!chatId || agents.has(ev.agent_id)) continue
          agents.set(ev.agent_id, {
            id: ev.agent_id,
            type: ev.agent_type || 'agent',
            base: ev.agent_base,
            chatId,
            started: ev.t,
            progress: {},
            lastEdit: 0,
          })
        } else {
          const a = agents.get(ev.agent_id)
          if (a && !a.done) a.done = ev.t
        }
      }
      for (const a of agents.values()) {
        refresh(a)
        const quietSince = Math.max(a.started, a.progress.updatedAt ?? 0)
        if (!a.done && t - quietSince > AGENT_STALE_MS) a.done = t
        flush(a, t)
        // Keep a finished agent until its final text has gone out, or a minute.
        if (a.done && !a.sending && (a.sentText === render(a, t) || t - a.done > 60_000)) agents.delete(a.id)
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
