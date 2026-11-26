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
// budget: one send or edit per this gap. Twelve seconds, at most 300 an hour
// and 7,200 a day: two installations' chats were held for hours, every send
// into them included, after about 10,800 sends and edits there in 24 hours,
// nearly all of them edits of this message, one of them at a six-second gap,
// while full days of about 9,000 drew no hold. Telegram publishes no limit.
export const CHAT_GAP_MS = 12000
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

// A field on one line, within max UTF-16 units, cut between graphemes.
function oneLine(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return cut(t, max, UNITS) ?? '…'
}

// Telegram counts a plain message in UTF-16 units, and this plugin measured a
// rich one in UTF-8 bytes (rich.ts), so a frame is measured in its form's own
// unit, the … included: 1 unit, or 3 bytes.
type Measure = (s: string) => number
const UNITS: Measure = s => s.length
const BYTES: Measure = s => Buffer.byteLength(s, 'utf8')

// A cut falls only between graphemes, so an emoji with its variation selector
// (⚠️), a ZWJ sequence (👩‍💻), a flag (🇩🇪) and a keycap (1️⃣) stay whole or
// go whole.
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const graphemesOf = (s: string) => Array.from(GRAPHEMES.segment(s), g => g.segment)

// The longest start of s, whole graphemes only, that fits room with … after
// it; undefined when not even one grapheme does.
function cut(s: string, room: number, measure: Measure): string | undefined {
  let kept = ''
  let used = measure('…')
  for (const g of graphemesOf(s)) {
    used += measure(g)
    if (used > room) break
    kept += g
  }
  return kept ? kept + '…' : undefined
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
  // Set once Telegram refused the message as a rich message: it is plain for
  // the rest of its life. A replacement chooses its form again.
  plain?: boolean
  gone?: boolean
  failures: number
  sending?: boolean
  // The send or edit on its way, settled once Telegram answers.
  inflight?: Promise<void>
  sentKey?: string
  // The clock of the frame Telegram last accepted. A late edit renders at it,
  // so the rest of an ended group's message stays as that frame showed it.
  frameAt?: number
  lastEdit: number
}

// A row the server stopped following while it still ran: the server cannot
// tell why it shut down, so the line says only that, and for how long the row
// was followed.
const unfollowed = (a: Agent, closedAt: number) => `🔌 No longer followed after ${formatDuration(closedAt - a.started)}`

// A row's parts, in the order they show: its status, its type, its
// description, its step and its end (its clock and token count). A running
// row's status is followed by a space, any other's by ` · `.
type Row = {
  status: string
  running: boolean
  type: string
  description?: string
  // `last: ` before the step of a row no longer running.
  stepLead?: string
  step?: string
  end: string[]
}

// A shell's line carries its description and clock; it ends as done, failed
// with its exit code, or stopped. It never goes quiet: a shell can wait in
// silence for as long as it likes, and Claude Code marks every ending.
function shellRow(a: Agent, now: number, closedAt?: number): Row {
  const row = { type: 'shell', description: a.description ? oneLine(a.description) : undefined, running: false, end: [] as string[] }
  if (a.done === undefined && closedAt !== undefined) return { ...row, status: unfollowed(a, closedAt) }
  if (a.done === undefined) return { ...row, status: '⏳', running: true, end: [formatDuration(now - a.started)] }
  const took = formatDuration(a.done - a.started)
  if (a.outcome === 'stopped') return { ...row, status: `⏹ Stopped after ${took}` }
  if (a.outcome === 'failed') return { ...row, status: `❌ Failed after ${took}${a.exitCode !== undefined ? ` (exit ${a.exitCode})` : ''}` }
  return { ...row, status: `✅ Done in ${took}` }
}

const isQuiet = (a: Agent, now: number) => a.kind !== 'shell' && a.done === undefined && now - a.quietSince > AGENT_STALE_MS

// With closedAt, the frame is the server's last: a row still running reads as
// no longer followed, and every other row as it was.
function rowOf(a: Agent, now: number, closedAt?: number): Row {
  if (a.kind === 'shell') return shellRow(a, now, closedAt)
  const type = oneLine(a.type, 32)
  const description = a.description ? oneLine(a.description) : undefined
  const tokens = a.progress.tokens ? [`${formatTokens(a.progress.tokens)} tokens`] : []
  if (a.done !== undefined) {
    const took = formatDuration(a.done - a.started)
    const status = a.outcome === 'stopped' ? `⏹ Stopped after ${took}`
      : a.outcome === 'failed' ? `❌ Failed after ${took}${a.error ? ` (${a.error})` : ''}`
      : `✅ Done in ${took}`
    return { status, running: false, type, description, end: tokens }
  }
  const step = oneLine(a.progress.step ?? 'Starting…')
  if (closedAt !== undefined && !a.dropped) return { status: unfollowed(a, closedAt), running: false, type, description, stepLead: 'last: ', step, end: tokens }
  if (isQuiet(a, now)) {
    return { status: `⚠️ No activity for ${formatDuration(now - a.quietSince)}`, running: false, type, description, stepLead: 'last: ', step, end: tokens }
  }
  return { status: '⏳', running: true, type, description, step, end: [formatDuration(now - a.started), ...tokens] }
}

// A row's line with its type or not, and the description and step given.
function rowLine(r: Row, type: boolean, description: string | undefined, step: string | undefined): string {
  const parts = [type ? r.type : undefined, description, step === undefined ? undefined : `${r.stepLead ?? ''}${step}`, ...r.end]
    .filter((p): p is string => p !== undefined)
  return parts.length ? `${r.status}${r.running ? ' ' : ' · '}${parts.join(' · ')}` : r.status
}

// A row's whole line.
export function render(a: Agent, now: number, closedAt?: number): string {
  const r = rowOf(a, now, closedAt)
  return rowLine(r, true, r.description, r.step)
}

// A row within its share: whole if it fits; else it gives up its type, then
// its description, in part or whole, then its step, in part or whole, each …
// inside the part it shortens. Its status, clock and token count go only when
// they alone pass the share; then the row's end goes.
function fit(lead: string, r: Row, share: number, measure: Measure): string {
  const whole = lead + rowLine(r, true, r.description, r.step)
  if (measure(whole) <= share) return whole
  const untyped = lead + rowLine(r, false, r.description, r.step)
  if (measure(untyped) <= share) return untyped
  // What the rest of the line takes, beside a one-unit stand-in for the part
  // that shortens.
  const beside = (description: string | undefined, step: string | undefined) => measure(lead + rowLine(r, false, description, step)) - 1
  if (r.description !== undefined) {
    const description = cut(r.description, share - beside('x', r.step), measure)
    if (description !== undefined) return lead + rowLine(r, false, description, r.step)
  }
  const bare = lead + rowLine(r, false, undefined, r.step)
  if (measure(bare) <= share) return bare
  if (r.step !== undefined) {
    const step = cut(r.step, share - beside(undefined, 'x'), measure)
    if (step !== undefined) return lead + rowLine(r, false, undefined, step)
  }
  const stepless = lead + rowLine(r, false, undefined, undefined)
  if (measure(stepless) <= share) return stepless
  return cut(stepless, share, measure) ?? ''
}

// What the message says apart from its clock.
function contentKey(a: Agent, now: number): string {
  return JSON.stringify([a.kind, a.type, a.description, a.progress.step, a.progress.tokens, a.done, a.outcome,
    a.error, a.exitCode, isQuiet(a, now), a.dropped])
}

export const AGENT_MESSAGE_LIMIT = 4096
const MAX_PANEL_ROWS = 100

// A frame's room: its size in its form's unit, and the rows it shows at most.
// A plain message holds 4,096 UTF-16 units; a rich one the bytes the server
// gives, in its one paragraph.
type Room = { size: number; measure: Measure; rows: number }
const PLAIN_ROOM: Room = { size: AGENT_MESSAGE_LIMIT, measure: UNITS, rows: MAX_PANEL_ROWS }
const richRoom = (rich: RichPanel): Room => ({ size: rich.bytes, measure: BYTES, rows: MAX_PANEL_ROWS })

// Each row's share of the room, taken from the shortest row up: its whole
// length, or an equal share of the room still left, whichever is less, so the
// room a short row leaves goes to the longer ones, and no row gets less than
// an equal share of the whole room.
function shares(lengths: number[], room: number): number[] {
  const out = lengths.map(() => 0)
  const order = lengths.map((_, i) => i).sort((a, b) => lengths[a]! - lengths[b]! || a - b)
  let left = room
  let rows = lengths.length
  for (const i of order) {
    out[i] = Math.min(lengths[i]!, Math.floor(left / rows))
    left -= out[i]!
    rows--
  }
  return out
}

const isEnded = (a: Agent) => a.done !== undefined || !!a.dropped
const hasLeft = (a: Agent, t: number) => a.endShownAt !== undefined && t - a.endShownAt >= FINISHED_ROW_MS

function panel(batch: Batch, agents: Map<string, Agent>, t: number, closedAt?: number, room: Room = PLAIN_ROOM) {
  // Only the rows still in the message count: for the cap, the count of more
  // rows, the header and each row's share.
  const members = [...batch.members.values()].filter(a => !hasLeft(a, t))
  let shown = members.map(a => ({ a, ordinal: batch.numbers.get(a.key)!, key: contentKey(a, t), ended: isEnded(a) }))
    .sort((a, b) => a.ordinal - b.ordinal)
  if (shown.length > room.rows) {
    // If even shortened rows cannot all fit, show unacknowledged endings and
    // new agents first, then running agents, ahead of finished history.
    const priority = (a: Agent) => a.done !== undefined && agents.get(a.key) === a ? 0
      : !a.shown ? 1 : a.done === undefined && !a.dropped ? 2 : 3
    shown.sort((a, b) => priority(a.a) - priority(b.a) || a.ordinal - b.ordinal)
    shown = shown.slice(0, room.rows).sort((a, b) => a.ordinal - b.ordinal)
  }
  const shells = members.some(a => a.kind === 'shell')
  const subagents = members.some(a => a.kind !== 'shell')
  const header = [subagents && '🤖 Subagents', shells && '🐚 Shells'].filter(Boolean).join(' · ')
  const noun = shells && subagents ? 'tasks' : shells ? 'shells' : 'agents'
  const suffix = members.length > shown.length ? `\n… ${members.length - shown.length} more ${noun}` : ''
  const rows = shown.map(({ a, ordinal }) => ({ lead: `${ordinal}. `, row: rowOf(a, t, closedAt) }))
  const { measure } = room
  const given = shares(rows.map(({ lead, row }) => measure(lead + rowLine(row, true, row.description, row.step))),
    room.size - measure(header) - measure(suffix) - shown.length)
  const text = header + rows.map(({ lead, row }, i) => '\n' + fit(lead, row, given[i]!, measure)).join('') + suffix
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
// text is the plain closing frame, within 4,096 units; rich, the rich one,
// every row whole, is there only while the message is a rich message.
export type PanelRecords = {
  write(chatId: string, msgId: number, text: string, rich?: string): void
  remove(chatId: string, msgId: number): void
}

// A message is plain text or, with rich messages on, a rich message of one
// plain-string paragraph holding its text, its lines joined by line breaks,
// which Telegram keeps and shows as line breaks.
export type PanelForm = 'plain' | 'rich'

// With rich messages on: the room of a rich frame, which Telegram answers
// count as refusing a rich call (rich.ts's plainFallback), and where the
// stream's lines go (the server's log). A frame is one paragraph, one block,
// so the room is its bytes alone. This file stays free of rich.ts, which
// imports packages the hook cannot load before `bun install`.
export type RichPanel = {
  bytes: number
  refused: (err: unknown) => boolean
  log: (line: string) => void
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
  edit(chatId: string, msgId: number, text: string, form?: PanelForm): Promise<void>
}

type ApiError = { description?: string; parameters?: { retry_after?: number } }

export function createAgentStream(opts: {
  readEvents: () => StreamEvent[]
  // The private chat to stream into, or undefined while there is none.
  chat: () => string | undefined
  send: (chatId: string, text: string, form?: PanelForm) => Promise<number | undefined>
  edit: (chatId: string, msgId: number, text: string, form?: PanelForm) => Promise<void>
  // With rich messages on, each message starts as a rich message.
  rich?: RichPanel
  readFile?: (path: string) => string | undefined
  mtime?: (path: string) => number | undefined
  listDir?: (path: string) => string[] | undefined
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  records?: PanelRecords
  // The polling server's sweep, run on each tick until the stream closes.
  sweep?: (slots: SweepSlots) => void
  // When the hold Telegram set on a chat ends, 0 when it is not held: a 429
  // any call got there (see flood.ts). The chat gets nothing until then.
  holdUntil?: (chatId: string) => number
}): AgentStream {
  const now = opts.now ?? Date.now
  const readFile = opts.readFile ?? tailOf
  const mtime = opts.mtime ?? mtimeOf
  const listDir = opts.listDir ?? listDirOf
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const records = opts.records
  const rich = opts.rich
  // A message's form, and the room of its frames.
  const formOf = (b: Batch): PanelForm => rich && !b.plain ? 'rich' : 'plain'
  const roomOf = (form: PanelForm): Room => form === 'rich' && rich ? richRoom(rich) : PLAIN_ROOM
  // A rich call Telegram refused: the message goes plain from the chat's next
  // slot, and stays plain.
  function refusedRich(b: Batch, form: PanelForm, call: 'send' | 'edit', err: unknown): boolean {
    if (form !== 'rich' || !rich?.refused(err)) return false
    b.plain = true
    rich.log(`subagents message: rich ${call} refused, plain from the next slot: ${String((err as ApiError | undefined)?.description ?? err)}`)
    return true
  }
  const agents = new Map<string, Agent>()
  // Rows whose transcript closed them after the message showed it: they are
  // out of the rows, and their transcript is still read, so a run that goes
  // on opens its row again.
  const watched = new Map<string, Agent>()
  // Stops whose start has not been read yet: the two hooks run concurrently.
  const earlyStops = new Map<string, StreamEvent>()
  const batches = new Map<string, Batch>()
  // Ended groups whose message owes one more edit: a stop hook gave one of
  // their rows its final ending after the group ended. Each takes its chat's
  // next slot without becoming that chat's group, so a newer group there keeps
  // its own message.
  const late = new Set<Batch>()
  const chatNext = new Map<string, number>()
  // The chat's next slot, which every send and edit asks for: the later of
  // the chat's own spacing, its own 429 waits included, and its hold.
  const nextSlot = (chatId: string) => Math.max(chatNext.get(chatId) ?? 0, opts.holdUntil?.(chatId) ?? 0)
  let first = true
  let ticks = 0
  // The current tick's time, which the sweep's slots share with the flush.
  let tickAt = 0
  let closing: Promise<void> | undefined
  // The close-time frames of each message, once the stream closes.
  const closeTexts = new Map<Batch, Closing>()

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

  // A watched row's final ending, from a stop hook: an open group shows it in
  // its next frame; an ended group's message owes one more edit. The record
  // takes that final frame first, so a server that stops before the edit
  // leaves it to the next one.
  function reopenGroup(a: Agent, t: number) {
    const b = a.group
    if (!b || b.gone || b.msgId === undefined || batches.get(b.chatId) === b) return
    if (!late.has(b)) b.failures = 0
    late.add(b)
    keep(b, b.msgId, closingOf(b, b.frameAt ?? t))
  }

  // The one more edit an ended group's message owes, at its chat's next slot:
  // its last frame with the endings that came since, a row that has left the
  // message staying out. Once Telegram has the frame, or the message is gone,
  // the group is done with; a message that keeps refusing keeps its record
  // for the next server.
  function flushLate(b: Batch, t: number) {
    if (b.sending) return
    const msgId = b.msgId!
    const at = b.frameAt ?? t
    const form = formOf(b)
    const frame = panel(b, agents, at, undefined, roomOf(form))
    const finish = () => { late.delete(b); records?.remove(b.chatId, msgId) }
    if (frame.key === b.sentKey) return finish()
    if (t < nextSlot(b.chatId)) return
    chatNext.set(b.chatId, t + CHAT_GAP_MS)
    b.sending = true
    keep(b, msgId, closingOf(b, at))
    b.inflight = Promise.resolve().then(() => opts.edit(b.chatId, msgId, frame.text, form)).then(() => { b.sentKey = frame.key }, (err: unknown) => {
      const e = (err ?? {}) as ApiError
      const desc = String(e.description ?? err)
      const retry = e.parameters?.retry_after
      if (/message is not modified/i.test(desc)) b.sentKey = frame.key
      else if (retry) chatNext.set(b.chatId, now() + retry * 1000)
      else if (/message to edit not found|message can't be edited/i.test(desc)) finish()
      // A refusal is no failure: the edit goes plain at the chat's next slot.
      else if (refusedRich(b, form, 'edit', err)) {}
      else if (++b.failures >= 5) late.delete(b)
    }).finally(() => {
      b.sending = false
      if (late.has(b) && b.sentKey === panel(b, agents, at).key) finish()
    })
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

  // The closing frames of a frame: every row still running reads as no longer
  // followed, every other row as it was. text is plain, within 4,096 units;
  // rich, every row whole, is there while the message is a rich message.
  type Closing = { text: string; rich?: string }
  const closingOf = (batch: Batch, t: number): Closing => {
    const text = panel(batch, agents, t, t).text
    return formOf(batch) === 'rich' ? { text, rich: panel(batch, agents, t, t, roomOf('rich')).text } : { text }
  }
  const keep = (batch: Batch, msgId: number, c: Closing) => records?.write(batch.chatId, msgId, c.text, c.rich)

  // A group whose rows have all ended, and whose final frame Telegram has
  // accepted or whose message is gone, ends: its message stays as it is, and
  // the next overlapping group gets a new one.
  function endIfFinished(batch: Batch, allLeft = false) {
    if (batches.get(batch.chatId) !== batch || batch.sending) return
    // A group whose rows have all left the message ends with no edit: its
    // last frame already shows their endings, and a frame of no rows is empty.
    const finished = [...batch.members.values()].every(settled)
    if (!allLeft && (!finished || !(batch.gone || batch.sentKey === panel(batch, agents, now()).key))) return
    batches.delete(batch.chatId)
    for (const a of batch.members.values()) retire(a)
    if (batch.msgId === undefined) return
    // A gone message keeps its record, with the final frame, for the next
    // server; a message whose final frame went out needs no closing.
    if (batch.gone) keep(batch, batch.msgId, closingOf(batch, now()))
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
        if (batch.msgId !== undefined) keep(batch, batch.msgId, closingOf(batch, t))
        batches.delete(batch.chatId)
      }
      return
    }
    // A row that left with its ending acknowledged is done with; its number
    // stays taken, so a resumed subagent comes back under it. When every row
    // leaves at once, the group ends with its rows kept: the message still
    // shows them, and a late stop for one of them edits that message.
    const leaving = [...batch.members].filter(([key, a]) => hasLeft(a, t) && agents.get(key) !== a)
    if (leaving.length === batch.members.size) return endIfFinished(batch, true)
    for (const [key] of leaving) batch.members.delete(key)
    const form = formOf(batch)
    const frame = panel(batch, agents, t, undefined, roomOf(form))
    const running = [...batch.members.values()].some(a => a.done === undefined && !a.dropped)
    if (frame.key === batch.sentKey && (!running || t - batch.lastEdit < CLOCK_REFRESH_MS)) {
      // The tick that confirms a transcript ending has nothing new to show,
      // so it ends the group here.
      endIfFinished(batch)
      return
    }
    const chatId = batch.chatId
    if (t < nextSlot(chatId)) return
    chatNext.set(chatId, t + CHAT_GAP_MS)
    batch.sending = true
    batch.lastEdit = t
    const ok = () => {
      batch.sentKey = frame.key
      batch.frameAt = t
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
        // would only spend the next server a call. The replacement chooses
        // its form again.
        if (batch.msgId !== undefined) records?.remove(chatId, batch.msgId)
        batch.msgId = undefined
        batch.plain = undefined
      } else if (refusedRich(batch, form, batch.msgId === undefined ? 'send' : 'edit', err)) {
        // The refusal took this slot; the frame goes plain at the next.
      } else if (++batch.failures >= 5) batch.gone = true
    }
    const done = () => {
      batch.sending = false
      endIfFinished(batch)
    }
    if (batch.msgId === undefined) {
      const closing = closingOf(batch, t)
      batch.inflight = Promise.resolve().then(() => opts.send(chatId, frame.text, form)).then(id => {
        if (id === undefined) { fail(new Error('Telegram send returned no message id')); return }
        batch.msgId = id
        // Once the stream is closing, the record takes the close-time frame.
        keep(batch, id, closeTexts.get(batch) ?? closing)
        ok()
      }, fail).finally(done)
    } else {
      keep(batch, batch.msgId, closingOf(batch, t))
      batch.inflight = Promise.resolve().then(() => opts.edit(chatId, batch.msgId!, frame.text, form)).then(ok, fail).finally(done)
    }
  }

  // The server's last edit of one live message. A send or edit still on its
  // way settles first, so the closing edit never races it, and a first send
  // gives the message its id. The edit then waits for the chat's next slot,
  // read again after each wait, so a hold set meanwhile counts, and is not
  // made when that slot comes after startBy. Rows that finished keep their
  // lines; rows still running read as no longer followed.
  async function closeBatch(batch: Batch, closedAt: number, startBy: number) {
    while (batch.sending) await batch.inflight?.catch(() => {})
    // A group whose final frame went out in that answer has ended, and its
    // message stays as it is.
    if (batch.gone || batch.msgId === undefined || batches.get(batch.chatId) !== batch) return
    const closing = closeTexts.get(batch) ?? closingOf(batch, closedAt)
    const form = formOf(batch)
    const text = form === 'rich' && closing.rich !== undefined ? closing.rich : closing.text
    for (;;) {
      const slot = Math.max(now(), nextSlot(batch.chatId))
      if (slot > startBy) return
      if (slot <= now()) break
      await sleep(slot - now())
    }
    chatNext.set(batch.chatId, now() + CHAT_GAP_MS)
    const msgId = batch.msgId
    try {
      await opts.edit(batch.chatId, msgId, text, form)
    } catch (err) {
      // Any other answer leaves the record for the next server that polls;
      // a refused rich edit leaves it without its rich frame, so that server
      // edits the plain one.
      const e = (err ?? {}) as ApiError
      const desc = String(e.description ?? err)
      if (/message is not modified/i.test(desc)) {}
      else {
        if (!e.parameters?.retry_after && !/message to edit not found|message can't be edited/i.test(desc)
          && refusedRich(batch, form, 'edit', err)) keep(batch, msgId, { text: closing.text })
        return
      }
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
            reopenGroup(w, t)
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
      const before: Agent = { ...a, progress: { ...a.progress } }
      refresh(a)
      if (a.done === undefined) {
        watched.delete(key)
        agents.set(key, a)
        // A row that goes on in a new message leaves its line in its ended
        // group's message as it was, for a late stop that edits that message
        // once more.
        const g = a.group
        if (g && batches.get(g.chatId) !== g && g.members.get(key) === a) g.members.set(key, before)
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
      if (closing || t < nextSlot(chatId)) return false
      chatNext.set(chatId, t + CHAT_GAP_MS)
      return true
    },
    holdUntil(chatId, t) {
      chatNext.set(chatId, Math.max(chatNext.get(chatId) ?? 0, t))
    },
    edit: (chatId, msgId, text, form) => opts.edit(chatId, msgId, text, form),
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
      // A late edit goes next, for the same reason: it is one edit, and the
      // live message would otherwise take its slot.
      for (const b of late) flushLate(b, t)
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
          const closing = closingOf(b, closedAt)
          closeTexts.set(b, closing)
          if (b.msgId !== undefined) keep(b, b.msgId, closing)
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
