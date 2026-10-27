// Streams concurrent Claude Code subagents and background shells in one live
// Telegram message:
//
//   🤖 Subagents · 🐚 Shells
//   1. ⏳ general-purpose · Review PRs · Checking gate · 4m 31s · 85.4k tokens
//   2. ⏳ shell · Wait for CI · 2m 5s
//   3. ❌ Failed after 12s (exit 1) · shell · Run the tests
//
// A finished row leaves the message five minutes after the message first
// showed it finished; every row keeps the number it joined with. When the
// server shuts down, one last edit marks each row still running as no longer
// followed, and the server keeps a record of each open message's closing text,
// so the next server that polls the bot closes a message whose server died
// before it could.
//
// The plugin's SubagentStart, SubagentStop and PostToolUse hook
// (hooks/subagent.ts) appends one line per event to a file named for the
// Claude Code pid. The server reads the files of its ancestors, then follows
// each subagent's own transcript for its current step and token count, and its
// meta file for its description, in the workflow run's own folder for a
// workflow's subagent; and each shell's output file for the line Claude Code
// appends when the shell ends.
//
// This file carries no dependencies beyond Node's, so the hook can import it
// before `bun install` has run.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'fs'
import { tmpdir } from 'os'
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
// A finished row leaves the message this long after the first send or edit
// Telegram accepted with its ending, so the rows still running keep their room.
export const FINISHED_ROW_MS = 5 * 60 * 1000
// Once the server shuts down, its closing edit waits for the chat's next slot,
// at most CHAT_GAP_MS away, then has this long to reach Telegram.
export const CLOSING_EDIT_MS = 2000
const TAIL_BYTES = 256 * 1024

export type AgentEvent = {
  t: number
  event: 'start' | 'stop'
  agent_id: string
  agent_type?: string
  // <session transcript dir>/<session id>/subagents/agent-<id>, without suffix.
  // A workflow's subagent keeps its files in subagents/workflows/<run id>/
  // instead, where the stream finds them.
  agent_base?: string
  // Stopped by TaskStop, or failed on an API error (StopFailure); a
  // SubagentStop carries none.
  outcome?: 'stopped' | 'failed'
  // The class of a failed stop's API error, such as rate_limit.
  error?: string
}

// A background shell. Its own event names and id field keep it out of an
// older server's subagent rows.
export type ShellEvent = {
  t: number
  event: 'shell_start' | 'shell_stop'
  task_id: string
  description?: string
  // The file Claude Code writes the shell's output to.
  output?: string
  outcome?: 'stopped'
}

export type StreamEvent = AgentEvent | ShellEvent

export function agentEventFile(dir: string, pid: number): string {
  return join(dir, 'agents', `pid-${pid}.jsonl`)
}

export function appendAgentEvent(file: string, ev: StreamEvent): void {
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
  tool_name?: string
  tool_input?: { task_id?: string }
  tool_response?: unknown
  error?: unknown
}, now: number = Date.now(), files: TranscriptFiles = {}): AgentEvent | undefined {
  // A subagent whose query ends on an API error gets StopFailure, carrying its
  // id, and no SubagentStop. The main session's StopFailure carries no id.
  // The stop is stamped with Claude Code's own time for the error: its newest
  // API-error entry in the subagent's transcript, once that has landed, else
  // the hook's clock. So an earlier run's late StopFailure never counts
  // against a resumed run that started after that error.
  if (input.hook_event_name === 'StopFailure') {
    if (!input.agent_id || !/^[\w-]+$/.test(input.agent_id)) return undefined
    const error = errorClass(input.error)
    const base = subagentBase(input.transcript_path, input.agent_id)
    const found = base === undefined ? undefined : locateBase(base, input.agent_id, files.mtime ?? mtimeOf, files.listDir ?? listDirOf)
    const tail = found === undefined ? undefined : (files.readFile ?? tailOf)(`${found}.jsonl`)
    const stamped = tail === undefined ? undefined : newestApiError(tail)
    return { t: stamped ?? now, event: 'stop', agent_id: input.agent_id, outcome: 'failed', ...(error ? { error } : {}) }
  }
  // TaskStop does not run SubagentStop. Only a successful stop of a local
  // agent counts; a failed request or a stopped shell task must not close it.
  if (input.hook_event_name === 'PostToolUse' && input.tool_name === 'TaskStop') {
    let result = input.tool_response
    if (typeof result === 'string') {
      try { result = JSON.parse(result) } catch { return undefined }
    }
    if (!result || typeof result !== 'object') return undefined
    const r = result as { task_id?: string; task_type?: string; message?: string }
    if (r.task_type !== 'local_agent' || typeof r.task_id !== 'string'
      || !/^[\w-]+$/.test(r.task_id) || r.task_id !== input.tool_input?.task_id
      || typeof r.message !== 'string' || !r.message.startsWith(`Successfully stopped task: ${r.task_id}`)) return undefined
    return { t: now, event: 'stop', agent_id: r.task_id, outcome: 'stopped' }
  }
  const event = input.hook_event_name === 'SubagentStart' ? 'start'
    : input.hook_event_name === 'SubagentStop' ? 'stop' : undefined
  if (!event || !input.agent_id || !/^[\w-]+$/.test(input.agent_id)) return undefined
  return { t: now, event, agent_id: input.agent_id, agent_type: input.agent_type, agent_base: subagentBase(input.transcript_path, input.agent_id) }
}

// An API error's class as Claude Code names it, such as rate_limit; unknown
// is no class, whichever signal carries it.
function errorClass(error: unknown): string | undefined {
  return typeof error === 'string' && /^[a-z_]{1,40}$/.test(error) && error !== 'unknown' ? error : undefined
}

// The subagent's files sit beside the session transcript, in a directory named
// for the session. A nested subagent's hook may name its parent subagent's
// transcript, which already sits in the session's flat subagents directory.
function subagentBase(tp: string | undefined, agentId: string): string | undefined {
  if (!tp?.endsWith('.jsonl')) return undefined
  return /[\\/]subagents[\\/]agent-[^\\/]+\.jsonl$/.test(tp) ? join(tp, '..', `agent-${agentId}`)
    : join(tp.slice(0, -'.jsonl'.length), 'subagents', `agent-${agentId}`)
}

export type TranscriptFiles = {
  readFile?: (path: string) => string | undefined
  mtime?: (path: string) => number | undefined
  listDir?: (path: string) => string[] | undefined
}

// A workflow's agent, whatever its type, keeps its files in
// <session>/subagents/workflows/<run id>/, not beside the session's other
// subagents, and they can appear after its start hook ran: while none sit
// where the row looks, look in each run folder.
function locateBase(base: string, agentId: string, mtime: (path: string) => number | undefined,
  listDir: (path: string) => string[] | undefined): string | undefined {
  const has = (b: string) => mtime(`${b}.jsonl`) !== undefined || mtime(`${b}.meta.json`) !== undefined
  if (has(base)) return base
  const runs = join(base, '..', 'workflows')
  for (const run of listDir(runs) ?? []) {
    const b = join(runs, run, `agent-${agentId}`)
    if (has(b)) return b
  }
  return undefined
}

function parsedResponse(response: unknown): Record<string, unknown> | undefined {
  let result = response
  if (typeof result === 'string') {
    try { result = JSON.parse(result) } catch { return undefined }
  }
  return result && typeof result === 'object' ? result as Record<string, unknown> : undefined
}

// PostToolUse hook input → shell event. A Bash call whose result names a
// background task starts a shell, however it went to the background; its
// description labels it, never its command. A successful TaskStop of a shell
// stops it. Every other call is no event, before any file system access.
export function shellEventFromHook(input: {
  hook_event_name?: string
  session_id?: string
  tool_name?: string
  tool_input?: { description?: unknown; task_id?: string }
  tool_response?: unknown
}, now: number = Date.now(), findOutput: (taskId: string, sessionId?: string) => string | undefined = shellOutputFile): ShellEvent | undefined {
  if (input.hook_event_name !== 'PostToolUse') return undefined
  if (input.tool_name === 'Bash') {
    const r = parsedResponse(input.tool_response)
    const id = r?.backgroundTaskId
    if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) return undefined
    // Without its output file the stream could never see the shell end.
    const output = findOutput(id, input.session_id)
    if (!output) return undefined
    const d = input.tool_input?.description
    const description = typeof d === 'string' && d.trim() ? oneLine(d, 200) : undefined
    return { t: now, event: 'shell_start', task_id: id, description, output }
  }
  if (input.tool_name === 'TaskStop') {
    const r = parsedResponse(input.tool_response) as { task_id?: unknown; task_type?: unknown; message?: unknown } | undefined
    if (r?.task_type !== 'local_bash' || typeof r.task_id !== 'string'
      || !/^[\w-]+$/.test(r.task_id) || r.task_id !== input.tool_input?.task_id
      || typeof r.message !== 'string' || !r.message.startsWith(`Successfully stopped task: ${r.task_id}`)) return undefined
    return { t: now, event: 'shell_stop', task_id: r.task_id, outcome: 'stopped' }
  }
  return undefined
}

// Claude Code writes a background shell's output to
// <CLAUDE_CODE_TMPDIR or the OS temp dir, resolved>/claude-<uid>/<project>/<session id>/tasks/<task id>.output.
// The project key follows the session's start folder and the session id can
// change, while the task id cannot, so this looks the file up by task id: in
// the session's folder first, then in any.
export function shellOutputFile(taskId: string, sessionId?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!/^[\w-]+$/.test(taskId)) return undefined
  let base = env.CLAUDE_CODE_TMPDIR || tmpdir()
  try { base = realpathSync(base) } catch {}
  const root = join(base, `claude-${process.getuid?.() ?? 0}`)
  const name = `${taskId}.output`
  const list = (dir: string) => { try { return readdirSync(dir) } catch { return [] } }
  const projects = list(root)
  if (sessionId && /^[\w-]+$/.test(sessionId)) {
    for (const p of projects) {
      const f = join(root, p, sessionId, 'tasks', name)
      if (existsSync(f)) return f
    }
  }
  for (const p of projects) {
    for (const s of list(join(root, p))) {
      const f = join(root, p, s, 'tasks', name)
      if (existsSync(f)) return f
    }
  }
  return undefined
}

export type ShellEnd = { outcome?: 'stopped' | 'failed'; exitCode?: number }

// The line Claude Code appends to a shell's output file once the shell ends:
// `[exited with code N]`, with `unknown` for no code, or `[killed]` when it is
// stopped: by TaskStop, by the end of the subagent that started it, or by
// Claude exiting.
export function shellEndFromOutput(text: string): ShellEnd | undefined {
  const m = /(?:^|\n)\[(?:killed|exited with code (-?\d+|unknown))\]\n?$/.exec(text)
  if (!m) return undefined
  if (m[1] === undefined) return { outcome: 'stopped' }
  if (m[1] === '0') return { exitCode: 0 }
  return { outcome: 'failed', exitCode: m[1] === 'unknown' ? undefined : Number(m[1]) }
}

// Reads what was appended to each file since the last call.
export function createEventReader(files: string[], fromNow = true) {
  const offsets = new Map<string, number>()
  for (const f of files) {
    let size = 0
    try { size = statSync(f).size } catch {}
    offsets.set(f, fromNow ? size : 0)
  }
  return (): StreamEvent[] => {
    const out: StreamEvent[] = []
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
          const ev = JSON.parse(line) as StreamEvent
          if (ev.event === 'start' || ev.event === 'stop' ? typeof ev.agent_id === 'string' && ev.agent_id
            : (ev.event === 'shell_start' || ev.event === 'shell_stop') && typeof ev.task_id === 'string' && ev.task_id) out.push(ev)
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

// The newest conversation entry of a subagent's transcript, which says whether
// its run ended: an assistant entry Claude Code wrote for an API error, or the
// marker of an interruption. Claude Code ends a subagent's query on several
// API errors without any stop hook, and records an interruption even when no
// stop hook ran. Only the latest user or assistant entry counts, never quoted
// text in an earlier one: an agent can be resumed after either. Its other
// lines (attachments, request records) are skipped, and so is a line cut off
// at either end of the tail.
export type TranscriptEntry = {
  // The entry's own id, which tells a later read whether it is still the newest.
  id: string
  at?: number
  kind: 'error' | 'interruption' | 'other'
  error?: string
  // An interruption Claude Code writes when its own process shuts down, which
  // is no ending of the run.
  shutdown?: boolean
}

export function newestEntry(text: string): TranscriptEntry | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    let e: { type?: string; uuid?: unknown; timestamp?: string; isApiErrorMessage?: unknown; error?: unknown
      interruptedByShutdown?: unknown; message?: { content?: unknown } }
    try { e = JSON.parse(lines[i]!) } catch { continue }
    if (!e || typeof e !== 'object' || (e.type !== 'user' && e.type !== 'assistant')) continue
    const t = Date.parse(e.timestamp ?? '')
    const at = Number.isFinite(t) ? t : undefined
    const id = typeof e.uuid === 'string' ? e.uuid : `${e.type}@${e.timestamp ?? i}`
    if (e.type === 'assistant' && e.isApiErrorMessage === true) {
      const error = errorClass(e.error)
      return { id, at, kind: 'error', ...(error ? { error } : {}) }
    }
    const content = e.type === 'user' && Array.isArray(e.message?.content) ? e.message!.content as { type?: string; text?: string }[] : []
    if (content.length === 1 && content[0]?.type === 'text'
      && /^\[Request interrupted by user(?: for tool use)?\]$/.test(content[0].text ?? '')) {
      return { id, at, kind: 'interruption', ...(e.interruptedByShutdown === true ? { shutdown: true } : {}) }
    }
    return { id, at, kind: 'other' }
  }
  return undefined
}

// The time of the newest assistant entry Claude Code wrote for an API error.
export function newestApiError(text: string): number | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.includes('"isApiErrorMessage"')) continue
    let e: { type?: string; timestamp?: string; isApiErrorMessage?: unknown }
    try { e = JSON.parse(lines[i]!) } catch { continue }
    if (e?.type !== 'assistant' || e.isApiErrorMessage !== true) continue
    const t = Date.parse(e.timestamp ?? '')
    if (Number.isFinite(t)) return t
  }
  return undefined
}

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
    let e: { type?: string; timestamp?: string; isApiErrorMessage?: unknown; message?: { usage?: Record<string, number>; content?: unknown[] } }
    try { e = JSON.parse(line) } catch { continue }
    // Claude Code's entry for an API error is no step, and its usage is zero:
    // a failed row keeps its last real step and token count.
    if (e.isApiErrorMessage === true) continue
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
  if (t.length <= max) return t
  let end = Math.max(0, max - 1)
  // Telegram counts UTF-16 units; never cut an emoji between its surrogates.
  if (end > 0 && /[\uD800-\uDBFF]/.test(t[end - 1]!)) end--
  return t.slice(0, end) + '…'
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
  // The id names a subagent or a shell; the key keeps the two apart.
  key: string
  kind?: 'shell'
  type: string
  base?: string
  description?: string
  chatId?: string
  started: number
  progress: Progress
  quietSince: number
  transcriptMtime?: number
  done?: number
  outcome?: 'stopped' | 'failed'
  // A failed subagent's error class.
  error?: string
  // A shell's output file, its last change, and its exit code once it ends.
  output?: string
  outputMtime?: number
  exitCode?: number
  shown?: boolean
  dropped?: boolean
  // When Telegram first accepted a send or edit carrying this run's ending,
  // or a dropped subagent's line after its drop.
  endShownAt?: number
  // Where the row's ending came from: a stop hook, which is final, or the
  // subagent's own transcript, which a newer entry can take back.
  endedBy?: 'hook' | 'transcript'
  // Set once an ending came from the transcript, and kept when the row opens
  // again: a start for its id then replaces the row.
  fromTranscript?: boolean
  // The transcript entry that closed the row, the tick that read it, and
  // whether a later tick found it still the newest.
  endEntry?: string
  endTick?: number
  confirmed?: boolean
  // Set when the last read of the transcript found no whole user or assistant
  // entry: an unchanged file then cannot confirm the ending.
  noEntry?: boolean
  // The group whose message last carried this row.
  group?: Batch
}

const shellKey = (taskId: string) => `shell:${taskId}`

type Batch = {
  chatId: string
  members: Map<string, Agent>
  // The number each row got when it joined, kept for the message's life, so a
  // number names the same subagent or shell after rows before it left.
  numbers: Map<string, number>
  lastNumber: number
  msgId?: number
  gone?: boolean
  failures: number
  sending?: boolean
  // The send or edit on its way, settled once Telegram answers.
  inflight?: Promise<void>
  sentKey?: string
  lastEdit: number
}

// A row the server stopped following while it still ran: the server cannot
// tell why it shut down, so the line says only that, and for how long the row
// was followed.
const unfollowed = (a: Agent, closedAt: number) => `🔌 No longer followed after ${formatDuration(closedAt - a.started)}`

// A shell's line carries its description and clock; it ends as done, failed
// with its exit code, or stopped. It never goes quiet: a shell can wait in
// silence for as long as it likes, and Claude Code marks every ending.
function renderShell(a: Agent, now: number, closedAt?: number): string {
  const label = `shell${a.description ? ` · ${oneLine(a.description)}` : ''}`
  if (a.done === undefined && closedAt !== undefined) return `${unfollowed(a, closedAt)} · ${label}`
  if (a.done === undefined) return `⏳ ${label} · ${formatDuration(now - a.started)}`
  const took = formatDuration(a.done - a.started)
  if (a.outcome === 'stopped') return `⏹ Stopped after ${took} · ${label}`
  if (a.outcome === 'failed') return `❌ Failed after ${took}${a.exitCode !== undefined ? ` (exit ${a.exitCode})` : ''} · ${label}`
  return `✅ Done in ${took} · ${label}`
}

const isQuiet = (a: Agent, now: number) => a.kind !== 'shell' && a.done === undefined && now - a.quietSince > AGENT_STALE_MS

// With closedAt, the frame is the server's last: a row still running reads as
// no longer followed, and every other row as it was.
export function render(a: Agent, now: number, closedAt?: number): string {
  if (a.kind === 'shell') return renderShell(a, now, closedAt)
  const label = `${oneLine(a.type, 32)}${a.description ? ` · ${oneLine(a.description)}` : ''}`
  const tokens = a.progress.tokens ? ` · ${formatTokens(a.progress.tokens)} tokens` : ''
  if (a.done !== undefined) {
    const took = formatDuration(a.done - a.started)
    const ending = a.outcome === 'stopped' ? `⏹ Stopped after ${took}`
      : a.outcome === 'failed' ? `❌ Failed after ${took}${a.error ? ` (${a.error})` : ''}`
      : `✅ Done in ${took}`
    return `${ending} · ${label}${tokens}`
  }
  const step = oneLine(a.progress.step ?? 'Starting…')
  if (closedAt !== undefined && !a.dropped) return `${unfollowed(a, closedAt)} · ${label} · last: ${step}${tokens}`
  if (isQuiet(a, now)) {
    return `⚠️ No activity for ${formatDuration(now - a.quietSince)} · ${label} · last: ${step}${tokens}`
  }
  return `⏳ ${label} · ${step} · ${formatDuration(now - a.started)}${tokens}`
}

// What the message says apart from its clock.
function contentKey(a: Agent, now: number): string {
  return JSON.stringify([a.kind, a.type, a.description, a.progress.step, a.progress.tokens, a.done, a.outcome,
    a.error, a.exitCode, isQuiet(a, now), a.dropped])
}

export const AGENT_MESSAGE_LIMIT = 4096
const MAX_PANEL_ROWS = 100

const isEnded = (a: Agent) => a.done !== undefined || !!a.dropped
const hasLeft = (a: Agent, t: number) => a.endShownAt !== undefined && t - a.endShownAt >= FINISHED_ROW_MS

function panel(batch: Batch, agents: Map<string, Agent>, t: number, closedAt?: number) {
  // Only the rows still in the message count: for the cap, the count of more
  // rows, the header and each row's width.
  const members = [...batch.members.values()].filter(a => !hasLeft(a, t))
  let shown = members.map(a => ({ a, ordinal: batch.numbers.get(a.key)!, key: contentKey(a, t), ended: isEnded(a) }))
    .sort((a, b) => a.ordinal - b.ordinal)
  if (shown.length > MAX_PANEL_ROWS) {
    // If even shortened rows cannot all fit, show unacknowledged endings and
    // new agents first, then running agents, ahead of finished history.
    const priority = (a: Agent) => a.done !== undefined && agents.get(a.key) === a ? 0
      : !a.shown ? 1 : a.done === undefined && !a.dropped ? 2 : 3
    shown.sort((a, b) => priority(a.a) - priority(b.a) || a.ordinal - b.ordinal)
    shown = shown.slice(0, MAX_PANEL_ROWS).sort((a, b) => a.ordinal - b.ordinal)
  }
  const shells = members.some(a => a.kind === 'shell')
  const subagents = members.some(a => a.kind !== 'shell')
  const header = [subagents && '🤖 Subagents', shells && '🐚 Shells'].filter(Boolean).join(' · ')
  const noun = shells && subagents ? 'tasks' : shells ? 'shells' : 'agents'
  const suffix = members.length > shown.length ? `\n… ${members.length - shown.length} more ${noun}` : ''
  const width = Math.floor((AGENT_MESSAGE_LIMIT - header.length - suffix.length - shown.length) / Math.max(1, shown.length))
  const text = header + shown.map(({ a, ordinal }) => '\n' + oneLine(`${ordinal}. ${render(a, t, closedAt)}`, width)).join('') + suffix
  const key = JSON.stringify([members.map(a => [a.key, contentKey(a, t)]), shown.map(s => s.ordinal)])
  return { text, key, shown }
}

export type AgentStream = {
  tick(): void
  agents(): Agent[]
  // The server's shutdown: stops the stream, rewrites each open message's
  // record with the close-time frame, then makes one last edit of each live
  // message still open, after any send or edit on its way and at the chat's
  // next slot, if that slot comes by startBy. Resolves once those edits are
  // answered.
  close(startBy: number): Promise<void>
}

// The record of each open message: the text it should read once its writer is
// gone. A server writes one before each edit, with the closing text of the
// frame that edit sends, and right after a first send is answered, and
// deletes it once the message needs no closing: the group's final frame or
// the closing edit was accepted, or the message was replaced. See panels.ts.
export type PanelRecords = {
  write(chatId: string, msgId: number, text: string): void
  remove(chatId: string, msgId: number): void
}

// What the polling server's sweep of the records of servers that are gone
// gets from the stream: the per-chat clock the stream's own sends and edits
// keep, so a swept edit and a live one in the same chat keep its spacing.
export type SweepSlots = {
  now(): number
  // Takes the chat's next slot when it has come; false while it has not.
  take(chatId: string): boolean
  // Holds the chat until then, after Telegram asked to wait.
  holdUntil(chatId: string, t: number): void
  edit(chatId: string, msgId: number, text: string): Promise<void>
}

type ApiError = { description?: string; parameters?: { retry_after?: number } }

export function createAgentStream(opts: {
  readEvents: () => StreamEvent[]
  // The private chat to stream into, or undefined while there is none.
  chat: () => string | undefined
  send: (chatId: string, text: string) => Promise<number | undefined>
  edit: (chatId: string, msgId: number, text: string) => Promise<void>
  readFile?: (path: string) => string | undefined
  mtime?: (path: string) => number | undefined
  listDir?: (path: string) => string[] | undefined
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  records?: PanelRecords
  // The polling server's sweep, run on each tick until the stream closes.
  sweep?: (slots: SweepSlots) => void
}): AgentStream {
  const now = opts.now ?? Date.now
  const readFile = opts.readFile ?? tailOf
  const mtime = opts.mtime ?? mtimeOf
  const listDir = opts.listDir ?? listDirOf
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const records = opts.records
  const agents = new Map<string, Agent>()
  // Rows whose transcript closed them after the message showed it: they are
  // out of the rows, and their transcript is still read, so a run that goes
  // on opens its row again.
  const watched = new Map<string, Agent>()
  // Stops whose start has not been read yet: the two hooks run concurrently.
  const earlyStops = new Map<string, StreamEvent>()
  const batches = new Map<string, Batch>()
  const chatNext = new Map<string, number>()
  let first = true
  let ticks = 0
  // The current tick's time, which the sweep's slots share with the flush.
  let tickAt = 0
  let closing: Promise<void> | undefined
  // The close-time frame's text of each message, once the stream closes.
  const closeTexts = new Map<Batch, string>()

  // A row out of the rows: one its transcript closed stays watched, as long
  // as the stream still follows it; a row a later start replaced is done
  // with.
  function retire(a: Agent) {
    const followed = agents.get(a.key) === a || watched.get(a.key) === a
    if (agents.get(a.key) === a) agents.delete(a.key)
    if (followed && a.kind !== 'shell' && a.endedBy === 'transcript' && a.done !== undefined) watched.set(a.key, a)
  }

  // Whether a row's run ended in its transcript before a later start: an
  // API-error entry, or an interruption Claude Code did not write for its own
  // shutdown, stamped between the row's start and that start. A start read
  // while the row still shows running, as in the backlog a server reads at
  // its start, or when the ending, the resumed prompt and the start land
  // within one tick, still replaces it then.
  function endedBefore(a: Agent, t: number): boolean {
    if (a.kind === 'shell') return false
    locate(a)
    const tail = a.base ? readFile(`${a.base}.jsonl`) : undefined
    if (!tail) return false
    for (const line of tail.split('\n')) {
      if (!line.includes('"isApiErrorMessage"') && !line.includes('[Request interrupted by user')) continue
      const e = newestEntry(line)
      if (!e || e.at === undefined || e.at < a.started || e.at > t) continue
      if (e.kind === 'error' || (e.kind === 'interruption' && !e.shutdown)) return true
    }
    return false
  }

  // A stop hook's ending, which replaces an ending read from the transcript:
  // a SubagentStop that follows a transcript failure means the run went on
  // and finished.
  function endByHook(a: Agent, ev: StreamEvent) {
    const changed = a.endedBy === 'transcript'
    a.done = ev.t
    a.outcome = ev.outcome
    a.error = 'error' in ev ? ev.error : undefined
    a.endedBy = 'hook'
    a.endEntry = undefined
    a.confirmed = undefined
    if (changed) a.endShownAt = undefined
  }

  // A watched row's final ending, from a stop hook after its group ended: the
  // group's message takes one more edit with that ending, unless a newer group
  // holds the chat or the row has left the message.
  function reopenGroup(a: Agent) {
    const b = a.group
    if (!b || b.gone || b.msgId === undefined || batches.has(b.chatId) || b.members.get(a.key) !== a) return
    batches.set(b.chatId, b)
  }

  // The transcript rule: the newest entry closes the row as failed or
  // stopped, or, for a row the transcript closed, opens it again. A row a
  // stop hook closed stays closed. A tail with no whole entry changes nothing.
  function applyEntry(a: Agent, e: TranscriptEntry | undefined) {
    if (!e || a.endedBy === 'hook') return
    if (a.endedBy === 'transcript' && e.id === a.endEntry) {
      if (ticks > (a.endTick ?? ticks)) a.confirmed = true
      return
    }
    // A clock read in the hook guards an interruption, never an error.
    const failed = e.kind === 'error'
    const stopped = e.kind === 'interruption' && !e.shutdown && e.at !== undefined && e.at >= a.started
    if (failed || stopped) {
      a.done = failed ? Math.max(a.started, e.at ?? a.started) : e.at
      a.outcome = failed ? 'failed' : 'stopped'
      a.error = failed ? e.error : undefined
      a.endedBy = 'transcript'
      a.fromTranscript = true
      a.endEntry = e.id
      a.endTick = ticks
      a.confirmed = false
      a.endShownAt = undefined
    } else if (a.endedBy === 'transcript') {
      a.done = undefined
      a.outcome = undefined
      a.error = undefined
      a.endShownAt = undefined
      a.endedBy = undefined
      a.endEntry = undefined
      a.endTick = undefined
      a.confirmed = undefined
    }
  }

  // A shell ends with the line Claude Code appends to its output file; the
  // file's time then is when it ended.
  function refreshShell(a: Agent) {
    if (!a.output || a.done !== undefined) return
    const m = mtime(a.output)
    if (m === undefined || m === a.outputMtime) return
    a.outputMtime = m
    const end = shellEndFromOutput(readFile(a.output) ?? '')
    if (!end) return
    a.done = Math.max(a.started, m)
    a.outcome = end.outcome
    a.exitCode = end.exitCode
  }

  function locate(a: Agent) {
    if (!a.base) return
    const found = locateBase(a.base, a.id, mtime, listDir)
    if (found) a.base = found
  }

  function refresh(a: Agent) {
    if (a.kind === 'shell') return refreshShell(a)
    locate(a)
    if (!a.base) return
    if (a.description === undefined) {
      try {
        const meta = JSON.parse(readFile(`${a.base}.meta.json`) ?? '') as { description?: string; agentType?: string }
        if (typeof meta.description === 'string') a.description = meta.description
        if (typeof meta.agentType === 'string' && a.type === 'agent') a.type = meta.agentType
      } catch {}
    }
    const m = mtime(`${a.base}.jsonl`)
    if (m !== undefined && m !== a.transcriptMtime) {
      a.transcriptMtime = m
      a.quietSince = Math.max(a.quietSince, m)
      const tail = readFile(`${a.base}.jsonl`)
      const entry = tail ? newestEntry(tail) : undefined
      a.noEntry = entry === undefined
      if (tail) {
        a.progress = { ...a.progress, ...definedOnly(progressFromTranscript(tail)) }
        applyEntry(a, entry)
      }
    } else if (a.endedBy === 'transcript' && !a.noEntry && ticks > (a.endTick ?? ticks)) {
      // An unchanged transcript whose last read found the closing entry still
      // has it newest; one whose tail held no whole entry confirms nothing.
      a.confirmed = true
    }
  }

  // Whether a row's ending ends its group: one read only from the transcript
  // counts once a later tick found the same newest entry, so a frame that
  // shows it for one tick never closes the message on a run that goes on.
  const settled = (a: Agent) => !!a.dropped || (a.done !== undefined && (a.endedBy !== 'transcript' || !!a.confirmed))

  // The closing text of a frame: every row still running reads as no longer
  // followed, every other row as it was.
  const closingText = (batch: Batch, t: number) => panel(batch, agents, t, t).text

  // A group whose rows have all ended, and whose final frame Telegram has
  // accepted or whose message is gone, ends: its message stays as it is, and
  // the next overlapping group gets a new one.
  function endIfFinished(batch: Batch) {
    if (batches.get(batch.chatId) !== batch || batch.sending) return
    // A group whose rows have all left the message ends with no edit: its
    // last frame already shows their endings, and a frame of no rows is empty.
    const empty = batch.members.size === 0
    const finished = [...batch.members.values()].every(settled)
    if (!empty && (!finished || !(batch.gone || batch.sentKey === panel(batch, agents, now()).key))) return
    batches.delete(batch.chatId)
    for (const a of batch.members.values()) retire(a)
    if (batch.msgId === undefined) return
    // A gone message keeps its record, with the final frame, for the next
    // server; a message whose final frame went out needs no closing.
    if (batch.gone) records?.write(batch.chatId, batch.msgId, closingText(batch, now()))
    else records?.remove(batch.chatId, batch.msgId)
  }

  function flush(batch: Batch, t: number) {
    if (batch.sending) return
    if (batch.gone) {
      for (const a of batch.members.values()) {
        if (a.done !== undefined || a.dropped) retire(a)
      }
      if (![...batch.members.values()].some(a => a.done === undefined && !a.dropped)) {
        // The gone message's record first takes this final frame, so rows this
        // server saw finish keep their lines when the next server closes it.
        if (batch.msgId !== undefined) records?.write(batch.chatId, batch.msgId, closingText(batch, t))
        batches.delete(batch.chatId)
      }
      return
    }
    // A row that left with its ending acknowledged is done with; its number
    // stays taken, so a resumed subagent comes back under it.
    for (const [key, a] of batch.members) if (hasLeft(a, t) && agents.get(key) !== a) batch.members.delete(key)
    if (batch.members.size === 0) return endIfFinished(batch)
    const frame = panel(batch, agents, t)
    const running = [...batch.members.values()].some(a => a.done === undefined && !a.dropped)
    if (frame.key === batch.sentKey && (!running || t - batch.lastEdit < CLOCK_REFRESH_MS)) {
      // The tick that confirms a transcript ending has nothing new to show,
      // so it ends the group here.
      endIfFinished(batch)
      return
    }
    const chatId = batch.chatId
    if (t < (chatNext.get(chatId) ?? 0)) return
    chatNext.set(chatId, t + CHAT_GAP_MS)
    batch.sending = true
    batch.lastEdit = t
    const ok = () => {
      batch.sentKey = frame.key
      batch.failures = 0
      for (const { a, key, ended } of frame.shown) {
        a.shown = true
        // The five minutes run from the first accepted frame that carried the
        // ending, never from a frame built before it or one Telegram refused.
        if (ended) a.endShownAt ??= now()
        // An ending received while this send/edit was in flight still needs
        // its own acknowledgement. A resumed run is a different Agent object.
        if (contentKey(a, now()) === key && (a.done !== undefined || a.dropped)
          && agents.get(a.key) === a) retire(a)
      }
    }
    const fail = (err: unknown) => {
      const e = (err ?? {}) as ApiError
      const desc = String(e.description ?? err)
      if (/message is not modified/i.test(desc)) return ok()
      batch.lastEdit = 0 // retry once the chat allows, not at the next clock refresh
      const retry = e.parameters?.retry_after
      if (retry) { chatNext.set(chatId, now() + retry * 1000); return }
      if (/message to edit not found|message can't be edited/i.test(desc)) {
        // Replace a deleted panel on the next chat slot; the old one's record
        // would only spend the next server a call.
        if (batch.msgId !== undefined) records?.remove(chatId, batch.msgId)
        batch.msgId = undefined
      } else if (++batch.failures >= 5) batch.gone = true
    }
    const done = () => {
      batch.sending = false
      endIfFinished(batch)
    }
    if (batch.msgId === undefined) {
      const closeText = closingText(batch, t)
      batch.inflight = Promise.resolve().then(() => opts.send(chatId, frame.text)).then(id => {
        if (id === undefined) { fail(new Error('Telegram send returned no message id')); return }
        batch.msgId = id
        // Once the stream is closing, the record takes the close-time frame.
        records?.write(chatId, id, closeTexts.get(batch) ?? closeText)
        ok()
      }, fail).finally(done)
    } else {
      records?.write(chatId, batch.msgId, closingText(batch, t))
      batch.inflight = Promise.resolve().then(() => opts.edit(chatId, batch.msgId!, frame.text)).then(ok, fail).finally(done)
    }
  }

  // The server's last edit of one live message. A send or edit still on its
  // way settles first, so the closing edit never races it, and a first send
  // gives the message its id. The edit then waits for the chat's next slot,
  // and is not made when that slot comes after startBy. Rows that finished
  // keep their lines; rows still running read as no longer followed.
  async function closeBatch(batch: Batch, closedAt: number, startBy: number) {
    while (batch.sending) await batch.inflight?.catch(() => {})
    // A group whose final frame went out in that answer has ended, and its
    // message stays as it is.
    if (batch.gone || batch.msgId === undefined || batches.get(batch.chatId) !== batch) return
    const text = closeTexts.get(batch) ?? panel(batch, agents, closedAt, closedAt).text
    const slot = Math.max(now(), chatNext.get(batch.chatId) ?? 0)
    if (slot > startBy) return
    if (slot > now()) await sleep(slot - now())
    chatNext.set(batch.chatId, now() + CHAT_GAP_MS)
    const msgId = batch.msgId
    try {
      await opts.edit(batch.chatId, msgId, text)
    } catch (err) {
      // Any other answer leaves the record for the next server that polls.
      if (!/message is not modified/i.test(String((err as ApiError | undefined)?.description ?? err))) return
    }
    records?.remove(batch.chatId, msgId)
  }

  // Reads new events and each row's files, and places each row in its chat's
  // message.
  function update(t: number) {
    for (const ev of opts.readEvents()) {
      const key = 'task_id' in ev ? shellKey(ev.task_id) : ev.agent_id
      if (ev.event === 'start' || ev.event === 'shell_start') {
        const old = agents.get(key)
        // A start replaces a row whose last ending came from its transcript,
        // even one that has opened again since: a resumed run's prompt can
        // reach the transcript before its start hook writes.
        if (old && old.done === undefined && !old.fromTranscript && !endedBefore(old, ev.t)) continue
        // A shell's output file says whether it still runs, however old.
        if (ev.event === 'start' && t - ev.t > AGENT_STALE_MS) continue
        // The run it replaces stays in its chat: agents stay in the chat where
        // they first appeared, so a resumed run takes the earlier run's place
        // in that chat's message, never a second row in another.
        const chatId = (old ?? watched.get(key))?.chatId
        watched.delete(key)
        const a: Agent = 'task_id' in ev
          ? { id: ev.task_id, key, kind: 'shell', type: 'shell', description: ev.description, output: ev.output,
            started: ev.t, progress: {}, quietSince: ev.t, chatId }
          : { id: ev.agent_id, key, type: ev.agent_type || 'agent', base: ev.agent_base,
            started: ev.t, progress: {}, quietSince: ev.t, chatId }
        const stop = earlyStops.get(key)
        if (stop && stop.t >= ev.t) endByHook(a, stop)
        earlyStops.delete(key)
        agents.set(key, a)
      } else {
        // The clock guards decide whether a stop counts: it must be stamped no
        // earlier than the row's start, so an earlier run's late stop stays
        // off a resumed run.
        const a = agents.get(key)
        const w = a ? undefined : watched.get(key)
        if (a) {
          if (ev.t >= a.started && a.endedBy !== 'hook') endByHook(a, ev)
        } else if (w) {
          // A watched row's own stop is taken there, never kept as an early
          // stop, and its ending is final.
          if (ev.t >= w.started) {
            endByHook(w, ev)
            watched.delete(key)
            reopenGroup(w)
          }
        } else earlyStops.set(key, ev)
      }
    }
    // The first read is the backlog from before this server started: only
    // subagents and shells still running are of interest. A shell whose
    // output file is gone can no longer show its ending.
    if (first) {
      first = false
      for (const a of agents.values()) {
        refresh(a)
        if (a.done !== undefined) retire(a)
        else if (a.output && mtime(a.output) === undefined) agents.delete(a.key)
      }
      earlyStops.clear()
    }
    for (const [id, ev] of earlyStops) if (t - ev.t > 10 * 60 * 1000) earlyStops.delete(id)

    // A watched row whose transcript shows the run going on returns to the
    // rows as running, under its first start: in its group's message under
    // its old number while that group is open, else in a new message. One
    // whose transcript has been quiet as long as a running row may be leaves.
    for (const [key, a] of watched) {
      refresh(a)
      if (a.done === undefined) {
        watched.delete(key)
        agents.set(key, a)
      } else if (t - a.quietSince > AGENT_DROP_MS) watched.delete(key)
    }

    for (const a of agents.values()) {
      a.chatId ??= opts.chat()
      refresh(a)
      if (a.kind !== 'shell' && a.done === undefined && t - a.quietSince > AGENT_DROP_MS) a.dropped = true
      if (!a.chatId) {
        if (a.done !== undefined || a.dropped) retire(a)
        continue
      }
      let batch = batches.get(a.chatId)
      if (!batch) {
        batch = { chatId: a.chatId, members: new Map(), numbers: new Map(), lastNumber: 0, failures: 0, lastEdit: 0 }
        batches.set(a.chatId, batch)
      }
      if (!batch.numbers.has(a.key)) batch.numbers.set(a.key, ++batch.lastNumber)
      batch.members.set(a.key, a)
      a.group = batch
    }
  }

  const slots: SweepSlots = {
    now,
    take(chatId) {
      // The tick's own time, as the flush uses: a slot taken a few
      // milliseconds into the tick must not cost the next tick's send.
      const t = tickAt
      if (closing || t < (chatNext.get(chatId) ?? 0)) return false
      chatNext.set(chatId, t + CHAT_GAP_MS)
      return true
    },
    holdUntil(chatId, t) {
      chatNext.set(chatId, Math.max(chatNext.get(chatId) ?? 0, t))
    },
    edit: (chatId, msgId, text) => opts.edit(chatId, msgId, text),
  }

  return {
    tick() {
      if (closing) return
      ticks++
      const t = now()
      tickAt = t
      update(t)
      // The sweep goes first: a live message that changes on every tick would
      // otherwise take each of the chat's slots, and a message of a server
      // that is gone would never be closed.
      opts.sweep?.(slots)
      for (const batch of batches.values()) flush(batch, t)
    },
    agents() {
      return [...agents.values()]
    },
    close(startBy: number) {
      if (closing) return closing
      // Nothing flushes from here on: the closing edit is the last.
      const closedAt = now()
      closing = Promise.resolve().then(() => {
        update(closedAt)
        // Every open message's record takes the close-time frame before
        // anything in flight is waited for, so an answer that lands late
        // never puts an older frame back, whether or not the closing edit
        // then goes out.
        for (const b of batches.values()) {
          const text = panel(b, agents, closedAt, closedAt).text
          closeTexts.set(b, text)
          if (b.msgId !== undefined) records?.write(b.chatId, b.msgId, text)
        }
        return Promise.all([...batches.values()].map(b => closeBatch(b, closedAt, startBy).catch(() => {})))
      }).then(() => {}, () => {})
      return closing
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

function listDirOf(path: string): string[] | undefined {
  try {
    return readdirSync(path)
  } catch {
    return undefined
  }
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
