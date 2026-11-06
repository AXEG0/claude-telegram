import { describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AGENT_DROP_MS,
  AGENT_STALE_MS,
  AGENT_MESSAGE_LIMIT,
  AGENT_TICK_MS,
  CHAT_GAP_MS,
  CLOCK_REFRESH_MS,
  FINISHED_ROW_MS,
  agentEventFile,
  createAgentStream,
  createEventReader,
  eventFromHook,
  formatDuration,
  formatTokens,
  newestEntry,
  progressFromTranscript,
  shellEndFromOutput,
  shellEventFromHook,
  shellOutputFile,
  THINKING,
  WRITING,
  type AgentEvent,
  type ShellEvent,
  type StreamEvent,
  type SweepSlots,
} from './agents.ts'
import shellHooks from './fixtures/shell-hooks.json'
import workflowHooks from './fixtures/workflow-hooks.json'
import failureHooks from './fixtures/failure-hooks.json'
import { runRegistered } from './fixtures/hooks.ts'
import { apiError, assistantText, line, requestBlob, userText } from './fixtures/transcript.ts'

const assistant = (content: unknown[], usage?: Record<string, number>, ts = '2026-10-08T15:00:00.000Z') =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { content, usage } })
// With nothing new, a message is edited when its clock refresh is due and the
// chat's slot allows: the beat of its edits.
const BEAT_MS = Math.max(CLOCK_REFRESH_MS, CHAT_GAP_MS)

describe('eventFromHook', () => {
  test('maps start and stop, and places the subagent files beside the session transcript', () => {
    const ev = eventFromHook({
      hook_event_name: 'SubagentStart',
      agent_id: 'a40507641cb2de577',
      agent_type: 'general-purpose',
      transcript_path: '/h/.claude/projects/p/sess-1.jsonl',
    }, 5)
    expect(ev).toEqual({
      t: 5,
      event: 'start',
      agent_id: 'a40507641cb2de577',
      agent_type: 'general-purpose',
      agent_base: '/h/.claude/projects/p/sess-1/subagents/agent-a40507641cb2de577',
    })
    expect(eventFromHook({ hook_event_name: 'SubagentStop', agent_id: 'x1' })?.event).toBe('stop')
    expect(eventFromHook({
      hook_event_name: 'SubagentStart',
      agent_id: 'n2',
      transcript_path: '/h/p/sess-1/subagents/agent-parent.jsonl',
    })?.agent_base).toBe('/h/p/sess-1/subagents/agent-n2')
    expect(eventFromHook({ hook_event_name: 'Stop', agent_id: 'x1' })).toBeUndefined()
    expect(eventFromHook({ hook_event_name: 'SubagentStart', agent_id: '../x' })).toBeUndefined()
  })

  const stopped = {
    hook_event_name: 'PostToolUse', tool_name: 'TaskStop', tool_input: { task_id: 'a1' },
    tool_response: { task_id: 'a1', task_type: 'local_agent', message: 'Successfully stopped task: a1 (Review)' },
  }
  test('a successful TaskStop records a stopped outcome, from an object or JSON response', () => {
    expect(eventFromHook(stopped, 5)).toEqual({ t: 5, event: 'stop', agent_id: 'a1', outcome: 'stopped' })
    expect(eventFromHook({ ...stopped, tool_response: JSON.stringify(stopped.tool_response) }, 5))
      .toEqual(eventFromHook(stopped, 5))
  })
  test('failed stops and shell tasks do not close an agent', () => {
    expect(eventFromHook({ ...stopped, tool_response: { error: 'Task not found' } })).toBeUndefined()
    expect(eventFromHook({ ...stopped, tool_response: { ...stopped.tool_response, task_type: 'local_bash' } })).toBeUndefined()
    expect(eventFromHook({ ...stopped, tool_input: { task_id: 'other' } })).toBeUndefined()
    expect(eventFromHook({ ...stopped, tool_response: { ...stopped.tool_response, message: 'Failed to stop task' } })).toBeUndefined()
    expect(eventFromHook({ ...stopped, tool_response: 'bad JSON' })).toBeUndefined()
  })

  test('a subagent\'s StopFailure records a failed stop with its error class; the main session\'s records nothing', () => {
    expect(eventFromHook(failureHooks.subagent_stop_failure, 5)).toEqual({
      t: 5, event: 'stop', agent_id: failureHooks.subagent_stop_failure.agent_id, outcome: 'failed', error: 'model_not_found',
    })
    expect(eventFromHook(failureHooks.main_stop_failure)).toBeUndefined()
    expect(eventFromHook({ ...failureHooks.subagent_stop_failure, agent_id: '../x' })).toBeUndefined()
    expect(eventFromHook({ ...failureHooks.subagent_stop_failure, error: 'Not a class\nof error' }, 5))
      .toEqual({ t: 5, event: 'stop', agent_id: failureHooks.subagent_stop_failure.agent_id, outcome: 'failed' })
  })
})

// The fixtures are hook inputs recorded from Claude Code 2.1.296.
describe('shellEventFromHook', () => {
  test('a background Bash call starts a shell labelled by its description, never its command', () => {
    const asked: [string, string | undefined][] = []
    const ev = shellEventFromHook(shellHooks.background_bash, 5, (id, session) => { asked.push([id, session]); return `/t/${id}.output` })
    expect(ev).toEqual({ t: 5, event: 'shell_start', task_id: 'bqo62tie2', description: 'Probe failing shell', output: '/t/bqo62tie2.output' })
    expect(asked).toEqual([['bqo62tie2', 'sess0001-test-4000-8000-000000000a01']])
    expect(JSON.stringify(ev)).not.toContain('exit 3')
    expect(shellEventFromHook(shellHooks.subagent_background_bash, 5, id => `/t/${id}.output`))
      .toMatchObject({ event: 'shell_start', task_id: 'b795t6qa7', description: 'Agent shell' })
    expect(eventFromHook(shellHooks.background_bash)).toBeUndefined()
  })

  test('a call without a background task looks for no file; a bad id or a missing file is no event', () => {
    let lookups = 0
    const find = (id: string) => { lookups++; return `/t/${id}.output` }
    expect(shellEventFromHook(shellHooks.foreground_bash, 5, find)).toBeUndefined()
    expect(shellEventFromHook({ ...shellHooks.background_bash, hook_event_name: 'PreToolUse' }, 5, find)).toBeUndefined()
    expect(lookups).toBe(0)
    const bg = shellHooks.background_bash
    expect(shellEventFromHook({ ...bg, tool_response: { ...bg.tool_response, backgroundTaskId: '../x' } }, 5, find)).toBeUndefined()
    expect(shellEventFromHook(bg, 5, () => undefined)).toBeUndefined()
    expect(shellEventFromHook({ ...bg, tool_input: { ...bg.tool_input, description: ' \n ' } }, 5, find)?.description).toBeUndefined()
    expect(shellEventFromHook({ ...bg, tool_response: JSON.stringify(bg.tool_response) }, 5, find)?.task_id).toBe('bqo62tie2')
  })

  test('a successful TaskStop of a shell stops it without its command; other stops do not', () => {
    const stop = shellHooks.task_stop_shell
    const ev = shellEventFromHook(stop, 5)
    expect(ev).toEqual({ t: 5, event: 'shell_stop', task_id: 'bm4vrn0w1', outcome: 'stopped' })
    expect(eventFromHook(stop)).toBeUndefined()
    expect(shellEventFromHook({ ...stop, tool_response: { ...stop.tool_response, task_type: 'local_agent' } })).toBeUndefined()
    expect(shellEventFromHook({ ...stop, tool_response: { ...stop.tool_response, message: 'Failed to stop task' } })).toBeUndefined()
    expect(shellEventFromHook({ ...stop, tool_input: { task_id: 'other' } })).toBeUndefined()
    expect(shellEventFromHook({ ...stop, tool_response: { error: 'Task not found' } })).toBeUndefined()
  })
})

describe('shellOutputFile', () => {
  const uid = process.getuid?.() ?? 0
  function tree() {
    const tmp = mkdtempSync(join(tmpdir(), 'shell-out-'))
    const tasks = join(tmp, `claude-${uid}`, '-home-me-project', 'sess-1', 'tasks')
    mkdirSync(tasks, { recursive: true })
    mkdirSync(join(tmp, `claude-${uid}`, '-other-project', 'sess-2'), { recursive: true })
    writeFileSync(join(tasks, 'b1.output'), '')
    return { env: { CLAUDE_CODE_TMPDIR: tmp }, file: join(realpathSync(tmp), `claude-${uid}`, '-home-me-project', 'sess-1', 'tasks', 'b1.output') }
  }
  test('finds the task file in the session folder, or by task id when the session id has changed', () => {
    const { env, file } = tree()
    expect(shellOutputFile('b1', 'sess-1', env)).toBe(file)
    expect(shellOutputFile('b1', 'sess-new', env)).toBe(file)
    expect(shellOutputFile('b1', undefined, env)).toBe(file)
  })
  test('a missing task, a missing temp folder or an unsafe id finds nothing', () => {
    const { env } = tree()
    expect(shellOutputFile('b2', 'sess-1', env)).toBeUndefined()
    expect(shellOutputFile('b1', 'sess-1', { CLAUDE_CODE_TMPDIR: '/nonexistent/tmp' })).toBeUndefined()
    expect(shellOutputFile('../b1', 'sess-1', env)).toBeUndefined()
    expect(shellOutputFile('b1', '../sess-1', env)).toBeDefined() // an unsafe session id is only skipped
  })
})

describe('shellEndFromOutput', () => {
  test('reads the line Claude Code appends when a shell ends', () => {
    // Byte for byte as Claude Code 2.1.296 wrote them.
    expect(shellEndFromOutput('ok\n\n[exited with code 0]\n')).toEqual({ exitCode: 0 })
    expect(shellEndFromOutput('out-a\n\n[exited with code 3]\n')).toEqual({ outcome: 'failed', exitCode: 3 })
    expect(shellEndFromOutput('\n[killed]\n')).toEqual({ outcome: 'stopped' })
    expect(shellEndFromOutput('\n[exited with code 0]\n')).toEqual({ exitCode: 0 })
    expect(shellEndFromOutput('x\n[exited with code unknown]\n')).toEqual({ outcome: 'failed', exitCode: undefined })
    expect(shellEndFromOutput('x\n[exited with code -1]\n')).toEqual({ outcome: 'failed', exitCode: -1 })
  })
  test('a running shell has no ending, even when its output mentions one', () => {
    expect(shellEndFromOutput('')).toBeUndefined()
    expect(shellEndFromOutput('building\n')).toBeUndefined()
    expect(shellEndFromOutput('\n[exited with code 0]\nmore output\n')).toBeUndefined()
    expect(shellEndFromOutput('echo [killed]\n')).toBeUndefined()
  })
})

const interrupted = (t: number, forToolUse = false) => JSON.stringify({
  type: 'user', timestamp: new Date(t).toISOString(),
  message: { role: 'user', content: [{ type: 'text', text: forToolUse ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]' }] },
})

// A workflow's subagents, as Claude Code 2.1.310 keeps them: the start hook
// names the session's own transcript, while each subagent's transcript and meta
// file sit in the workflow run's folder, <session>/subagents/workflows/<run id>/.
const WORKFLOW_RUN = 'wf_0a1b2c3d-001'
const workflowStartInput = (id: string, transcriptPath: string, agentType = 'workflow-subagent') =>
  ({ ...workflowHooks.subagent_start_workflow, agent_id: id, agent_type: agentType, transcript_path: transcriptPath })
const workflowMeta = (label: string, agentType = 'workflow-subagent') =>
  JSON.stringify({ agentType, isBuiltIn: true, description: label, workflowPhase: 'Check', spawnDepth: 1 })
const toolCall = (t: number, description: string, tokens: number) =>
  assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'true', description } }], { input_tokens: tokens }, new Date(t).toISOString())

describe('newestEntry', () => {
  const kind = (text: string) => newestEntry(text)?.kind
  test('reads an explicit terminal interruption, ignoring a partial line and trailing metadata', () => {
    expect(newestEntry(interrupted(5000) + '\n' + JSON.stringify({ type: 'attachment' }) + '\n{"type":'))
      .toMatchObject({ kind: 'interruption', at: 5000 })
  })
  test('ignores an interruption followed by resumed work or quoted in an answer', () => {
    expect(kind(interrupted(5000) + '\n' + assistant([{ type: 'text', text: 'Working again' }]))).toBe('other')
    expect(kind(interrupted(5000) + '\n' + JSON.stringify({ type: 'user', message: { content: 'Continue' } }))).toBe('other')
    expect(kind(assistant([{ type: 'text', text: '[Request interrupted by user]' }]))).toBe('other')
    expect(kind(JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }))).toBe('interruption')
  })
})

describe('createEventReader', () => {
  test('reads only what was appended, whole lines only', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'agents-')), 'pid-1.jsonl')
    writeFileSync(f, JSON.stringify({ t: 1, event: 'start', agent_id: 'old' }) + '\n')
    const read = createEventReader([f, '/nonexistent/file'])
    expect(read()).toEqual([])
    appendFileSync(f, JSON.stringify({ t: 2, event: 'start', agent_id: 'new' }) + '\n{"t":3,"event":"st')
    expect(read().map(e => e.agent_id)).toEqual(['new'])
    appendFileSync(f, 'op","agent_id":"new"}\n')
    expect(read()).toEqual([{ t: 3, event: 'stop', agent_id: 'new' }])
  })

  test('reads shell events beside subagent events, and drops lines without an id', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'agents-')), 'pid-1.jsonl')
    const read = createEventReader([f], false)
    const lines: unknown[] = [
      { t: 1, event: 'shell_start', task_id: 'b1', description: 'Build', output: '/t/b1.output' },
      { t: 2, event: 'start', agent_id: 'a1' },
      { t: 3, event: 'shell_stop', task_id: 'b1', outcome: 'stopped' },
      { t: 4, event: 'shell_start', agent_id: 'a2' },
      { t: 5, event: 'start', task_id: 'b2' },
    ]
    writeFileSync(f, lines.map(l => JSON.stringify(l) + '\n').join(''))
    expect(read().map(e => [e.event, 'task_id' in e ? e.task_id : e.agent_id])).toEqual([['shell_start', 'b1'], ['start', 'a1'], ['shell_stop', 'b1']])
  })
})

describe('progressFromTranscript', () => {
  test('the last tool call and the last request’s context size', () => {
    const text = [
      assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b/server.ts' } }], { input_tokens: 1, output_tokens: 1 }),
      assistant([{ type: 'text', text: 'hm' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'Checking gate mention and server env' } }],
        { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 84000, output_tokens: 400 }, '2026-10-08T15:04:31.000Z'),
    ].join('\n')
    expect(progressFromTranscript(text)).toEqual({
      step: 'Checking gate mention and server env',
      tokens: 85402,
      updatedAt: Date.parse('2026-10-08T15:04:31.000Z'),
    })
  })

  test('thinking once a tool has returned, writing once text comes', () => {
    const toolResult = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })
    const call = assistant([{ type: 'tool_use', name: 'Bash', input: { description: 'Run tests' } }], { input_tokens: 10 })
    expect(progressFromTranscript([call].join('\n')).step).toBe('Run tests')
    expect(progressFromTranscript([call, toolResult].join('\n'))).toMatchObject({ step: THINKING, tokens: 10 })
    expect(progressFromTranscript([call, toolResult, assistant([{ type: 'thinking', thinking: '' }])].join('\n')).step).toBe(THINKING)
    expect(progressFromTranscript([call, toolResult, assistant([{ type: 'text', text: 'Found it' }])].join('\n')).step).toBe(WRITING)
  })

  test('a tool without a description shows its tool and target', () => {
    expect(progressFromTranscript(assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b/server.ts' } }])).step)
      .toBe('Read server.ts')
    expect(progressFromTranscript(assistant([{ type: 'tool_use', name: 'Grep', input: { pattern: 'typing.start' } }])).step)
      .toBe('Grep typing.start')
  })

  test('commands, URLs and queries never leave the box without a description', () => {
    const step = (name: string, input: Record<string, unknown>) =>
      progressFromTranscript(assistant([{ type: 'tool_use', name, input }])).step
    expect(step('Bash', { command: 'curl -H "Authorization: Bearer ghp_x" https://x' })).toBe('Bash')
    expect(step('WebFetch', { url: 'https://x/items?token=sk_live_1' })).toBe('WebFetch')
    expect(step('Read', { file_path: 'C:\\Users\\me\\prod.env' })).toBe('Read prod.env')
  })

  test('formats like the CLI', () => {
    expect(formatTokens(85402)).toBe('85.4k')
    expect(formatTokens(999)).toBe('999')
    expect(formatDuration(271_000)).toBe('4m 31s')
    expect(formatDuration(42_000)).toBe('42s')
  })
})

describe('createAgentStream', () => {
  function harness(chat: string | null = '42') {
    let t = 1_000_000
    // The hold Telegram set on each chat, as the server's flood watch keeps
    // it, what runs once a sleep of the stream's has moved the clock, and the
    // polling server's sweep, if the test gives one.
    const holds = new Map<string, number>()
    let afterSleep: (() => void) | undefined
    let sweeping: ((slots: SweepSlots) => void) | undefined
    const events: StreamEvent[] = []
    const files = new Map<string, string>()
    const mtimes = new Map<string, number>()
    const sent: { chat: string; text: string }[] = []
    const edits: { id: number; text: string }[] = []
    // Every edit the stream tried: the clock when it went out, its text, and the
    // error Telegram answered, if any.
    const attempts: { at: number; text: string; error?: unknown }[] = []
    // Every send and edit the stream made, a sweep's included: the clock when
    // it went out, its chat, its message and its text.
    const calls: { at: number; chat: string; id: number; text: string }[] = []
    let failEdit: unknown
    let sendWait: Promise<void> | undefined
    let editWait: Promise<void> | undefined
    let current = chat
    // Each record write and deletion, with the clock when it happened.
    const records: { at: number; op: 'write' | 'remove'; chat: string; id: number; text?: string }[] = []
    const stream = createAgentStream({
      readEvents: () => events.splice(0),
      chat: () => current ?? undefined,
      send: async (c, text) => { sent.push({ chat: c, text }); const id = sent.length + 6; calls.push({ at: t, chat: c, id, text }); await sendWait; return id },
      edit: async (c, id, text) => {
        attempts.push({ at: t, text, error: failEdit })
        calls.push({ at: t, chat: c, id, text })
        if (failEdit) throw failEdit
        edits.push({ id, text })
        await editWait
      },
      readFile: p => files.get(p),
      mtime: p => mtimes.get(p),
      listDir: dir => {
        const names = new Set<string>()
        for (const p of files.keys()) if (p.startsWith(`${dir}/`)) names.add(p.slice(dir.length + 1).split('/')[0]!)
        return names.size ? [...names] : undefined
      },
      now: () => t,
      sleep: async ms => { t += ms; afterSleep?.() },
      holdUntil: c => holds.get(c) ?? 0,
      sweep: slots => sweeping?.(slots),
      records: {
        write: (c, id, text) => { records.push({ at: t, op: 'write', chat: c, id, text }) },
        remove: (c, id) => { records.push({ at: t, op: 'remove', chat: c, id }) },
      },
    })
    const settle = () => new Promise(r => setTimeout(r, 0))
    const tick = async () => { stream.tick(); await settle() }
    const write = (path: string, text: string) => { files.set(path, text); mtimes.set(path, t) }
    return {
      stream, events, sent, edits, tick, write,
      attempts, records, calls,
      advance: (ms: number) => { t += ms },
      now: () => t,
      setChat: (c: string | null) => { current = c },
      holdChat: (c: string, until: number) => { holds.set(c, until) },
      afterSleep: (run: () => void) => { afterSleep = run },
      sweepWith: (run: (slots: SweepSlots) => void) => { sweeping = run },
      failEditWith: (e: unknown) => { failEdit = e },
      holdSend: () => { let release!: () => void; sendWait = new Promise<void>(r => { release = r }); return () => { sendWait = undefined; release() } },
      holdEdit: () => { let release!: () => void; editWait = new Promise<void>(r => { release = r }); return () => { editWait = undefined; release() } },
    }
  }
  const start = (h: { now(): number }, id = 'a1', extra: Partial<AgentEvent> = {}): AgentEvent =>
    ({ t: h.now(), event: 'start', agent_id: id, agent_type: 'general-purpose', agent_base: `/s/agent-${id}`, ...extra })
  const shell = (h: { now(): number }, id: string, description?: string): ShellEvent =>
    ({ t: h.now(), event: 'shell_start', task_id: id, description, output: `/t/${id}.output` })

  test('shells share the subagents’ message and end as failed, done or stopped while the subagent keeps updating', async () => {
    const h = harness()
    await h.tick()
    h.write('/s/agent-a1.meta.json', JSON.stringify({ description: 'Review PRs' }))
    h.events.push(start(h), shell(h, 'b1', 'Run tests'), shell(h, 'b2', 'Wait for CI'), shell(h, 'b3', 'Install'))
    for (const id of ['b1', 'b2', 'b3']) h.write(`/t/${id}.output`, '')
    await h.tick()
    expect(h.sent).toEqual([{ chat: '42', text: '🤖 Subagents · 🐚 Shells\n'
      + '1. ⏳ general-purpose · Review PRs · Starting… · 0s\n2. ⏳ shell · Run tests · 0s\n3. ⏳ shell · Wait for CI · 0s\n4. ⏳ shell · Install · 0s' }])

    h.advance(CHAT_GAP_MS)
    h.write('/t/b1.output', 'FAIL agents.test.ts\n\n[exited with code 1]\n')
    h.write('/t/b3.output', 'ok\n\n[exited with code 0]\n')
    h.write('/s/agent-a1.jsonl', assistant([{ type: 'tool_use', name: 'Bash', input: { description: 'Checking gate' } }], { input_tokens: 85400 }))
    await h.tick()
    expect(h.edits.at(-1)).toEqual({ id: 7, text: '🤖 Subagents · 🐚 Shells\n'
      + '1. ⏳ general-purpose · Review PRs · Checking gate · 12s · 85.4k tokens\n2. ❌ Failed after 12s (exit 1) · shell · Run tests\n'
      + '3. ⏳ shell · Wait for CI · 12s\n4. ✅ Done in 12s · shell · Install' })

    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'shell_stop', task_id: 'b2', outcome: 'stopped' })
    h.write('/s/agent-a1.jsonl', assistant([{ type: 'text', text: 'Found it' }], { input_tokens: 90000 }))
    await h.tick()
    expect(h.edits.at(-1)?.text).toBe('🤖 Subagents · 🐚 Shells\n'
      + '1. ⏳ general-purpose · Review PRs · ✍️ Writing… · 24s · 90.0k tokens\n2. ❌ Failed after 12s (exit 1) · shell · Run tests\n'
      + '3. ⏹ Stopped after 24s · shell · Wait for CI\n4. ✅ Done in 12s · shell · Install')

    h.advance(CHAT_GAP_MS)
    h.write('/t/b2.output', '\n[killed]\n')
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a1' })
    await h.tick()
    expect(h.edits.at(-1)?.text).toContain('1. ✅ Done in 36s · general-purpose · Review PRs · 90.0k tokens\n')
    expect(h.edits.at(-1)?.text).toContain('3. ⏹ Stopped after 24s · shell · Wait for CI\n')
    await h.tick()
    expect(h.stream.agents()).toEqual([])
    expect(h.sent).toHaveLength(1)
    expect(new Set(h.edits.map(e => e.id))).toEqual(new Set([7]))
  })

  test('a shell killed with no hook, as when its subagent ends, shows as stopped', async () => {
    const h = harness()
    await h.tick()
    h.events.push(shell(h, 'b1', 'Agent shell'))
    h.write('/t/b1.output', '')
    await h.tick()
    h.advance(CHAT_GAP_MS)
    h.write('/t/b1.output', '\n[killed]\n')
    await h.tick()
    expect(h.edits.at(-1)).toEqual({ id: 7, text: '🐚 Shells\n1. ⏹ Stopped after 12s · shell · Agent shell' })
  })

  test('a shell that ended before its first tick shows its ending in the first message, labelled without a description', async () => {
    const h = harness()
    await h.tick()
    h.events.push(shell(h, 'b1'))
    h.advance(2000)
    h.write('/t/b1.output', 'x\n\n[exited with code 2]\n')
    await h.tick()
    expect(h.sent).toEqual([{ chat: '42', text: '🐚 Shells\n1. ❌ Failed after 2s (exit 2) · shell' }])
    await h.tick()
    expect(h.stream.agents()).toEqual([])
  })

  test('a shell waiting in silence for hours stays running, never quiet or dropped', async () => {
    const h = harness()
    await h.tick()
    h.events.push(shell(h, 'b1', 'Wait for CI'))
    h.write('/t/b1.output', '')
    await h.tick()
    h.advance(AGENT_DROP_MS + 2 * AGENT_STALE_MS)
    await h.tick()
    expect(h.edits.at(-1)?.text).toBe('🐚 Shells\n1. ⏳ shell · Wait for CI · 3h 0m')
    expect(h.stream.agents().map(a => a.id)).toEqual(['b1'])
    h.advance(CHAT_GAP_MS)
    h.write('/t/b1.output', '\n[exited with code 0]\n')
    await h.tick()
    expect(h.edits.at(-1)?.text).toBe('🐚 Shells\n1. ✅ Done in 3h 0m · shell · Wait for CI')
  })

  test('a shell stop read before its start still stops it', async () => {
    const h = harness()
    await h.tick()
    const s = shell(h, 'b1', 'Long wait')
    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'shell_stop', task_id: 'b1', outcome: 'stopped' }, s)
    await h.tick()
    expect(h.sent.at(-1)?.text).toBe('🐚 Shells\n1. ⏹ Stopped after 12s · shell · Long wait')
  })

  test('a shell and a subagent with the same id never end each other', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h, 'x1'), shell(h, 'x1', 'Same id'))
    await h.tick()
    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'x1', outcome: 'stopped' })
    await h.tick()
    expect(h.edits.at(-1)?.text).toBe('🤖 Subagents · 🐚 Shells\n1. ⏹ Stopped after 12s · general-purpose\n2. ⏳ shell · Same id · 12s')
    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'shell_stop', task_id: 'x1', outcome: 'stopped' })
    await h.tick()
    expect(h.edits.at(-1)?.text).toBe('🤖 Subagents · 🐚 Shells\n1. ⏹ Stopped after 12s · general-purpose\n2. ⏹ Stopped after 24s · shell · Same id')
  })

  test('the backlog keeps only shells still running, however long ago they started', async () => {
    const h = harness()
    h.events.push(shell(h, 'old', 'Long CI wait'))
    h.advance(AGENT_STALE_MS * 2)
    h.events.push(shell(h, 'done', 'Finished'), shell(h, 'run', 'Running'))
    h.write('/t/old.output', '')
    h.write('/t/done.output', '\n[exited with code 0]\n')
    h.write('/t/run.output', 'partial\n')
    h.events.push(shell(h, 'gone', 'Output file removed'))
    await h.tick()
    expect(h.stream.agents().map(a => a.id)).toEqual(['old', 'run'])
  })

  test('an oversized group of shells counts the rest as shells', async () => {
    const h = harness()
    await h.tick()
    for (let i = 0; i < 150; i++) h.events.push(shell(h, `b${i}`, `Shell ${i}`))
    await h.tick()
    expect(h.sent[0]!.text.length).toBeLessThanOrEqual(AGENT_MESSAGE_LIMIT)
    expect(h.sent[0]!.text).toStartWith('🐚 Shells\n1. ⏳ shell · Shell 0 · 0s\n')
    expect(h.sent[0]!.text).toEndWith('\n… 50 more shells')
  })

  test('one panel with one row per subagent, edited as it works, frozen when all finish', async () => {
    const h = harness()
    await h.tick() // the backlog read
    h.write('/s/agent-a1.meta.json', JSON.stringify({ description: 'Review PRs 3 and 4', agentType: 'general-purpose' }))
    h.events.push(start(h))
    await h.tick()
    expect(h.sent).toEqual([{ chat: '42', text: '🤖 Subagents\n1. ⏳ general-purpose · Review PRs 3 and 4 · Starting… · 0s' }])

    h.advance(CHAT_GAP_MS)
    h.write('/s/agent-a1.jsonl', assistant([{ type: 'tool_use', name: 'Bash', input: { description: 'Checking gate mention' } }],
      { input_tokens: 85400 }, new Date(h.now()).toISOString()))
    await h.tick()
    expect(h.edits).toEqual([{ id: 7, text: '🤖 Subagents\n1. ⏳ general-purpose · Review PRs 3 and 4 · Checking gate mention · 12s · 85.4k tokens' }])

    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a1' })
    await h.tick()
    expect(h.edits.at(-1)).toEqual({ id: 7, text: '🤖 Subagents\n1. ✅ Done in 24s · general-purpose · Review PRs 3 and 4 · 85.4k tokens' })
    await h.tick()
    expect(h.stream.agents()).toEqual([])
  })

  test('with nothing new, only the clock moves, and only every 10 seconds', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h))
    await h.tick()
    for (let i = 0; i < 3; i++) { h.advance(AGENT_TICK_MS); await h.tick() }
    expect(h.edits).toEqual([])
    h.advance(CLOCK_REFRESH_MS); await h.tick()
    expect(h.edits.length).toBe(1)
  })

  test('a stopped transcript closes the existing message on the next tick without a stop event', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h))
    h.write('/s/agent-a1.jsonl', assistant([{ type: 'text', text: 'Working' }], { input_tokens: 32300 }))
    await h.tick()
    expect(h.sent.at(-1)?.text).toContain(WRITING)
    h.advance(CHAT_GAP_MS)
    h.write('/s/agent-a1.jsonl', assistant([{ type: 'text', text: 'Working' }], { input_tokens: 32300 }) + '\n' + interrupted(h.now()))
    await h.tick()
    expect(h.edits.at(-1)).toEqual({ id: 7, text: '🤖 Subagents\n1. ⏹ Stopped after 12s · general-purpose · 32.3k tokens' })
    await h.tick()
    expect(h.stream.agents()).toEqual([])
    expect(h.sent).toHaveLength(1)
  })

  test('TaskStop closes an agent even when its transcript is unavailable', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h)); await h.tick()
    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a1', outcome: 'stopped' })
    await h.tick()
    expect(h.edits.at(-1)?.text).toContain('⏹ Stopped after 12s')
    await h.tick()
    expect(h.stream.agents()).toEqual([])
  })

  test('an interruption already present at start is read even when its mtime equals the start', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h))
    h.write('/s/agent-a1.jsonl', interrupted(h.now()))
    await h.tick()
    expect(h.sent.at(-1)?.text).toContain('⏹ Stopped after 0s')
  })

  test('a resumed agent ignores interruption evidence and stop hooks from its previous run', async () => {
    const h = harness()
    await h.tick()
    const old = h.now()
    h.write('/s/agent-a1.jsonl', interrupted(old))
    h.advance(AGENT_TICK_MS)
    h.events.push(start(h), { t: old, event: 'stop', agent_id: 'a1', outcome: 'stopped' })
    await h.tick()
    expect(h.sent.at(-1)?.text).toContain('⏳ general-purpose · Starting…')
    expect(h.stream.agents()).toHaveLength(1)
  })

  test('all simultaneous agents appear in a single send and share its edit budget', async () => {
    const h = harness()
    await h.tick()
    for (const id of ['a1', 'a2', 'a3']) h.events.push(start(h, id))
    await h.tick()
    expect(h.sent.length).toBe(1)
    expect(h.sent[0]!.text.split('\n')).toHaveLength(4)
    // Nothing new by the chat's next slot, so only the clock refresh edits,
    // once, with every row.
    h.advance(CHAT_GAP_MS); await h.tick()
    expect(h.sent.length).toBe(1)
    expect(h.edits.map(e => e.text.split('\n').length)).toEqual([4])
  })

  test('terminal rows and a busy agent update in the same edit', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h, 'busy'), start(h, 'stopped'))
    await h.tick()
    h.advance(CHAT_GAP_MS); await h.tick()
    h.advance(CHAT_GAP_MS)
    h.write('/s/agent-busy.jsonl', assistant([{ type: 'text', text: 'Working' }]))
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'stopped', outcome: 'stopped' })
    await h.tick()
    expect(h.edits.at(-1)?.text).toContain('⏹ Stopped after 24s')
    expect(h.edits.at(-1)?.text).toContain(WRITING)
  })

  test('four rows appear promptly even when the first agent changes on every tick for two minutes', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h, 'busy'))
    h.write('/s/agent-busy.meta.json', JSON.stringify({ description: 'Busy first agent' }))
    await h.tick()
    h.advance(AGENT_TICK_MS)
    for (const id of ['second', 'third', 'fourth']) {
      h.events.push(start(h, id))
      h.write(`/s/agent-${id}.meta.json`, JSON.stringify({ description: id }))
    }
    // The chat takes an edit every fourth tick, and each carries the step
    // written at its own tick.
    for (let i = 0; i < 40; i++) {
      h.write('/s/agent-busy.jsonl', assistant([{ type: 'tool_use', name: 'Bash', input: { description: `Step ${i}` } }]))
      if (i === 1) h.events.push({ t: h.now(), event: 'stop', agent_id: 'second', outcome: 'stopped' })
      if (i === 2) h.events.push({ t: h.now(), event: 'stop', agent_id: 'third' })
      const before = h.edits.length
      await h.tick()
      expect(h.edits.length - before).toBe(i % 4 === 3 ? 1 : 0)
      if (i % 4 === 3) {
        const text = h.edits.at(-1)!.text
        for (const label of ['Busy first agent', 'second', 'third', 'fourth']) expect(text).toContain(label)
        expect(text).toContain(`Step ${i}`)
        expect(text).toContain('2. ⏹ Stopped after')
        if (i >= 2) expect(text).toContain('3. ✅ Done in')
      }
      h.advance(AGENT_TICK_MS)
    }
    expect(h.edits).toHaveLength(10)
    expect(h.sent).toHaveLength(1)
    expect(new Set(h.edits.map(e => e.id))).toEqual(new Set([7]))
    expect(h.stream.agents().map(a => a.id)).toEqual(['busy', 'fourth'])
  })

  // A running row whose step stays the same while its token count grows on
  // every tick, written between ticks: each new count reaches the chat within
  // one 12-second slot, and the clock moves with it.
  test('a running row whose token count alone changes on every tick shows each new count within 12 seconds', async () => {
    const SLOT = 12_000
    const h = harness()
    await h.tick()
    h.events.push(start(h, 'a1'))
    h.write('/s/agent-a1.meta.json', JSON.stringify({ description: 'Long answer' }))
    h.write('/s/agent-a1.jsonl', assistant([{ type: 'text', text: 'Working' }], { input_tokens: 1000 }))
    await h.tick()
    const counts: { tokens: number; at: number }[] = []
    for (let i = 1; i <= 100; i++) {
      h.advance(1000)
      const tokens = 1000 + 100 * i
      h.write('/s/agent-a1.jsonl', assistant([{ type: 'text', text: 'Working' }], { input_tokens: tokens }))
      counts.push({ tokens, at: h.now() })
      h.advance(AGENT_TICK_MS - 1000)
      await h.tick()
    }
    // Each send and edit, with the count it shows.
    const shown = h.calls.map(c => ({ at: c.at, text: c.text, tokens: Math.round(1000 * Number(c.text.match(/· (\d+\.\d)k tokens$/)?.[1])) }))
    expect(shown.every(c => c.text.includes(WRITING))).toBe(true)
    // Each new count shows within one slot, itself or a later one.
    const late = counts.filter(c => !shown.some(e => e.at >= c.at && e.at <= c.at + SLOT && e.tokens >= c.tokens))
    expect(late).toEqual([])
    const gaps = shown.slice(1).map((e, i) => e.at - shown[i]!.at)
    expect(Math.max(...gaps)).toBe(SLOT)
    expect(Math.min(...gaps)).toBe(SLOT)
  })

  // A day of the plugin's own traffic into its chats, from one seed: subagents
  // and shells that overlap for hours, busy stretches where a subagent writes a
  // new step on every tick, half of them between ticks, quiet ones where only
  // the clock moves, groups that end and new ones that start, late stops, a
  // second chat, a gone server's messages swept while rows run, and the close
  // at the end. Telegram publishes no limit on edits; the bounds below are the
  // plugin's own pace, typed out so a change to it fails here.
  test('over a day of overlapping subagents and shells, the message goes into a chat at most once in any 12 seconds and 300 times an hour, each new step reaches it within 12 seconds, and its clock moves at least every 12', async () => {
    const SLOT = 12_000
    const CLOCK = 12_000
    const PER_HOUR = 300
    const MINUTE = 60_000
    const HOUR = 60 * MINUTE
    let seed = 75
    const rand = () => {
      seed = (seed + 0x6D2B79F5) | 0
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
      return ((x ^ (x >>> 14)) >>> 0) / 2 ** 32
    }
    const h = harness('1001')
    const day0 = h.now()
    // The day's stretches, in hours, and what starts in each: an idle stretch
    // starts nothing, so the group before it ends.
    const plan: [number, number, 'busy' | 'quiet' | 'mixed' | 'idle'][] = [
      [0, 3, 'busy'], [3, 3.25, 'idle'], [3.25, 8, 'quiet'], [8, 8.25, 'idle'], [8.25, 12, 'mixed'], [12, 12.25, 'idle'],
      [12.25, 16, 'mixed'], [16, 16.25, 'idle'], [16.25, 20, 'busy'], [20, 20.25, 'idle'], [20.25, 24, 'mixed'],
    ]
    // A gone server's message in the first chat, swept at hours 1, 9 and 17,
    // while rows run.
    const sweepAt = [1, 9, 17].map(x => day0 + x * HOUR)
    let swept = 0
    h.sweepWith(slots => {
      if (swept < sweepAt.length && slots.now() >= sweepAt[swept]! && slots.take('1001')) void slots.edit('1001', 900 + swept++, '🤖 Subagents\n1. 🔌 swept')
    })
    type Row = { id: string; shell: boolean; started: number; ends: number; busy: boolean; fails: boolean; between: boolean; n: number; stopAt?: number; closer?: boolean }
    const live: Row[] = []
    const steps: { id: string; n: number; at: number }[] = []
    const closers = new Set<number>()
    let made = 0
    // A subagent's new step, with its id and number in the step's text.
    const step = (r: Row) => {
      r.n++
      h.write(`/s/agent-${r.id}.jsonl`, toolCall(h.now(), `${r.id} s${r.n}`, 1000 * r.n))
      steps.push({ id: r.id, n: r.n, at: h.now() })
    }
    const begin = (r: Row) => {
      live.push(r)
      if (r.shell) { h.events.push(shell(h, r.id, r.id)); h.write(`/t/${r.id}.output`, ''); return }
      h.events.push(start(h, r.id))
      h.write(`/s/agent-${r.id}.meta.json`, JSON.stringify({ description: 'Job' }))
      step(r)
    }
    // A step goes until 15 s before the row ends, so its last one shows.
    const writing = (r: Row) => !r.shell && r.stopAt === undefined && h.now() < r.ends - 15_000
    await h.tick()
    while (h.now() < day0 + 24 * HOUR) {
      const t = h.now()
      const index = plan.findIndex(([from, to]) => t - day0 >= from * HOUR && t - day0 < to * HOUR)
      const [from, to, kind] = plan[index]!
      const end = day0 + to * HOUR
      // From hour 13 to 15 another chat writes last; rows stay in their chat.
      h.setChat(t - day0 >= 13 * HOUR && t - day0 < 15 * HOUR ? '1002' : '1001')
      // Each stretch opens with a busy subagent, so a group is live when the
      // stretch before's late stop comes.
      if (kind !== 'idle' && t === day0 + from * HOUR) {
        begin({ id: `a${++made}`, shell: false, started: t, ends: t + 10 * MINUTE + Math.floor(rand() * 20) * MINUTE, busy: true, fails: false, between: rand() < 0.5, n: 0 })
      }
      if (kind !== 'idle' && end - t > 3 * MINUTE && rand() < 1 / 60) {
        const isShell = rand() < (kind === 'quiet' ? 0.6 : 0.3)
        begin({ id: `${isShell ? 'b' : 'a'}${++made}`, shell: isShell, started: t, ends: Math.min(end, t + MINUTE + Math.floor(rand() * 30) * MINUTE),
          busy: !isShell && (kind === 'busy' || (kind === 'mixed' && rand() < 0.5)), fails: !isShell && rand() < 0.25, between: rand() < 0.5, n: 0 })
      }
      // The last row of each stretch fails at its end, from its transcript, and
      // its stop comes 20 minutes later, once its group has ended and the next
      // stretch's group is live in the same chat: a late stop.
      if (kind !== 'idle' && to < 24 && end - t <= 2 * MINUTE && !closers.has(index)) {
        closers.add(index)
        begin({ id: `a${++made}`, shell: false, started: t, ends: end, busy: false, fails: true, between: false, n: 0, closer: true })
      }
      for (const r of [...live]) {
        if (r.stopAt !== undefined) {
          if (t >= r.stopAt) { h.events.push({ t, event: 'stop', agent_id: r.id }); live.splice(live.indexOf(r), 1) }
        } else if (t >= r.ends) {
          if (r.shell) {
            h.write(`/t/${r.id}.output`, '\n[exited with code 0]\n')
            live.splice(live.indexOf(r), 1)
          } else if (r.fails) {
            h.write(`/s/agent-${r.id}.jsonl`, toolCall(t, `${r.id} s${r.n}`, 1000 * r.n) + '\n' + line(apiError(`e-${r.id}`, t, 'overloaded')))
            r.stopAt = t + (r.closer ? 20 * MINUTE : 45_000)
          } else {
            h.events.push({ t, event: 'stop', agent_id: r.id })
            live.splice(live.indexOf(r), 1)
          }
        } else if (writing(r) && (r.busy ? !r.between : (t - r.started) % (5 * MINUTE) === 0 && t > r.started)) step(r)
      }
      h.stream.tick()
      await new Promise(r => setImmediate(r))
      h.advance(100)
      for (const r of live) if (r.busy && r.between && writing(r)) step(r)
      h.advance(AGENT_TICK_MS - 100)
    }
    await h.stream.close(h.now() + SLOT)

    const calls = h.calls
    const marked = (text: string, id: string) => text.includes(`· ${id} s`)
    for (const chat of ['1001', '1002']) {
      const mine = calls.filter(c => c.chat === chat)
      // Never twice in any 12 seconds.
      const tight = mine.findIndex((c, i) => i > 0 && c.at - mine[i - 1]!.at < SLOT)
      expect(tight < 0 ? undefined : { chat, at: mine[tight]!.at - day0, gap: mine[tight]!.at - mine[tight - 1]!.at }).toBeUndefined()
      // At most 300 in any hour.
      let most = 0
      for (let i = 0, j = 0; i < mine.length; i++) {
        while (j < mine.length && mine[j]!.at < mine[i]!.at + HOUR) j++
        most = Math.max(most, j - i)
      }
      expect(most).toBeLessThanOrEqual(PER_HOUR)
      if (chat === '1001') expect(most).toBeGreaterThanOrEqual(295)
      else expect(mine.length).toBeGreaterThan(300)
      // While a row runs, its message moves at least every 12 seconds, except
      // when another message of the chat took the slot: a sweep or a late stop,
      // which go first.
      let open = 0
      const slow: object[] = []
      const last = new Map<number, number>()
      mine.forEach((b, i) => {
        const before = last.get(b.id)
        last.set(b.id, i)
        if (before === undefined || !mine[before]!.text.includes('⏳')) return
        const a = mine[before]!
        open += b.at - a.at
        if (b.at - a.at > CLOCK && i - before === 1) slow.push({ chat, id: b.id, at: a.at - day0, gap: b.at - a.at })
      })
      expect(slow).toEqual([])
      if (chat === '1001') expect(open).toBeGreaterThanOrEqual(12 * HOUR)
    }
    // Each new step reaches the chat within one 12-second slot, in a send or an
    // edit showing it or a later step, except when another message took the
    // slot first.
    const shown = new Map<string, { at: number; n: number }[]>()
    for (const c of calls) for (const m of c.text.matchAll(/· (a\d+) s(\d+) ·/g)) {
      const list = shown.get(m[1]!) ?? []
      list.push({ at: c.at, n: Number(m[2]) })
      shown.set(m[1]!, list)
    }
    let excused = 0
    const late: object[] = []
    for (const s of steps) {
      if ((shown.get(s.id) ?? []).some(e => e.at >= s.at && e.at <= s.at + SLOT && e.n >= s.n)) continue
      if (calls.some(c => c.at >= s.at && c.at <= s.at + SLOT && !marked(c.text, s.id))) { excused++; continue }
      late.push({ ...s, at: s.at - day0 })
    }
    expect(late).toEqual([])
    expect(steps.length).toBeGreaterThan(20_000)
    expect(excused).toBeLessThan(steps.length / 100)
    // The day's paths all ran: new groups' sends, the sweep, late stops.
    expect(h.sent.length).toBeGreaterThanOrEqual(8)
    expect(swept).toBe(3)
    // A late stop's edit of an ended group's message, while a newer message
    // of the same chat is live.
    const lastText = new Map<string, string>()
    let lateBeside = 0
    calls.forEach((c, i) => {
      const before = lastText.get(`${c.chat} ${c.id}`)
      lastText.set(`${c.chat} ${c.id}`, c.text)
      if (before === undefined || before.includes('⏳')) return
      const live = calls.slice(Math.max(0, i - 20), i).findLast(p => p.chat === c.chat && p.id !== c.id)
      if (live?.text.includes('⏳') && c.at - live.at <= CLOCK) lateBeside++
    })
    expect(lateBeside).toBeGreaterThanOrEqual(3)
  }, 120_000)

  // A day in which the message never rests: subagents and shells overlap for
  // the whole 24 hours, each running subagent writes a new step and token count
  // on every tick, and rows end and new ones join all day, so the message has
  // something new at every slot. The message's own pace is all that bounds it.
  // Telegram publishes no limit; two installations were held after about
  // 10,800 sends and edits into a chat in 24 hours. The bounds are typed out, so
  // a change to the pace fails here.
  test('over 24 hours in which rows change on every tick, the message goes into its chat at most once in any 12 seconds and at most 7,200 times', async () => {
    const SLOT = 12_000
    const PER_DAY = 7_200
    const MINUTE = 60_000
    const HOUR = 60 * MINUTE
    const DAY = 24 * HOUR
    let seed = 7200
    const rand = () => {
      seed = (seed + 0x6D2B79F5) | 0
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
      return ((x ^ (x >>> 14)) >>> 0) / 2 ** 32
    }
    const h = harness('1001')
    const day0 = h.now()
    type Row = { id: string; shell: boolean; ends: number; n: number }
    const live: Row[] = []
    const steps: { id: string; n: number; at: number }[] = []
    let made = 0
    let ended = 0
    const begin = (isShell: boolean) => {
      const t = h.now()
      // Lifetimes from 10 to 50 minutes, so rows end and join at all hours.
      const r: Row = { id: `${isShell ? 'b' : 'a'}${++made}`, shell: isShell, ends: t + 10 * MINUTE + Math.floor(rand() * 40 * MINUTE), n: 0 }
      live.push(r)
      if (isShell) { h.events.push(shell(h, r.id, r.id)); h.write(`/t/${r.id}.output`, ''); return }
      h.events.push(start(h, r.id))
      h.write(`/s/agent-${r.id}.meta.json`, JSON.stringify({ description: 'Job' }))
    }
    // Four subagents and two shells run at every moment; one that ends is
    // replaced at the same tick, while the others still run.
    for (let i = 0; i < 4; i++) begin(false)
    for (let i = 0; i < 2; i++) begin(true)
    while (h.now() < day0 + DAY) {
      const t = h.now()
      for (const r of [...live]) {
        if (t < r.ends) {
          // A new step and token count on every tick, until 15 s before the
          // row ends, so its last step shows before its ending.
          if (!r.shell && t < r.ends - 15_000) {
            r.n++
            h.write(`/s/agent-${r.id}.jsonl`, toolCall(t, `${r.id} s${r.n}`, 1000 * r.n))
            steps.push({ id: r.id, n: r.n, at: t })
          }
          continue
        }
        live.splice(live.indexOf(r), 1)
        ended++
        if (r.shell) h.write(`/t/${r.id}.output`, `\n[exited with code ${ended % 3 ? 0 : 1}]\n`)
        else h.events.push({ t, event: 'stop', agent_id: r.id, ...(ended % 4 ? {} : { outcome: 'stopped' as const }) })
        begin(r.shell)
      }
      h.stream.tick()
      await new Promise(r => setImmediate(r))
      h.advance(AGENT_TICK_MS)
    }
    await h.stream.close(h.now() + SLOT)

    const mine = h.calls.filter(c => c.chat === '1001')
    // At most 7,200 in any 24 hours, and the day kept the message busy enough
    // to reach it.
    let most = 0
    for (let i = 0, j = 0; i < mine.length; i++) {
      while (j < mine.length && mine[j]!.at < mine[i]!.at + DAY) j++
      most = Math.max(most, j - i)
    }
    expect(most).toBeLessThanOrEqual(PER_DAY)
    expect(most).toBeGreaterThanOrEqual(PER_DAY - 10)
    // Never twice in any 12 seconds.
    const tight = mine.findIndex((c, i) => i > 0 && c.at - mine[i - 1]!.at < SLOT)
    expect(tight < 0 ? undefined : { at: mine[tight]!.at - day0, gap: mine[tight]!.at - mine[tight - 1]!.at }).toBeUndefined()
    // One message all day: the group never ended.
    expect(h.sent).toHaveLength(1)
    expect(h.calls.filter(c => c.chat !== '1001')).toEqual([])
    // Each new step reaches the chat within one 12-second slot, in an edit
    // showing it or a later step; the close shows a running row's last step.
    const shown = new Map<string, { at: number; n: number }[]>()
    for (const c of mine) for (const m of c.text.matchAll(/(?:· |last: )(a\d+) s(\d+) ·/g)) {
      const list = shown.get(m[1]!) ?? []
      list.push({ at: c.at, n: Number(m[2]) })
      shown.set(m[1]!, list)
    }
    const late = steps.filter(s => !(shown.get(s.id) ?? []).some(e => e.at >= s.at && e.at <= s.at + SLOT && e.n >= s.n))
    expect(late.slice(0, 5).map(s => ({ ...s, at: s.at - day0 }))).toEqual([])
    expect(steps.length).toBeGreaterThan(100_000)
    expect(ended).toBeGreaterThan(200)
  }, 120_000)

  test('a completed panel stays intact and the next group gets a new message', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h, 'old')); await h.tick()
    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'old' }); await h.tick()
    const final = h.edits.at(-1)!
    h.events.push(start(h, 'new')); await h.tick()
    expect(h.sent).toHaveLength(1) // the shared chat rate limit crosses batches
    h.advance(CHAT_GAP_MS); await h.tick()
    expect(h.sent).toHaveLength(2)
    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'new' }); await h.tick()
    expect(h.edits.at(-1)?.id).toBe(8)
    expect(h.edits.filter(e => e.id === 7)).toEqual([final])
    expect(h.stream.agents()).toEqual([])
  })

  test('an agent starting while the first send is in flight joins the same message', async () => {
    const h = harness()
    await h.tick()
    const release = h.holdSend()
    h.events.push(start(h, 'first')); await h.tick()
    h.advance(CHAT_GAP_MS)
    h.events.push(start(h, 'second')); await h.tick()
    expect(h.sent).toHaveLength(1)
    expect(h.edits).toEqual([])
    release(); await h.tick(); await h.tick()
    expect(h.sent).toHaveLength(1)
    expect(h.edits.at(-1)?.text.split('\n')).toHaveLength(3)
    expect(h.edits.at(-1)?.id).toBe(7)
  })

  test('an ending received during an edit is not acknowledged by the older running frame', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h)); await h.tick()
    const release = h.holdEdit()
    h.advance(CLOCK_REFRESH_MS); await h.tick()
    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a1', outcome: 'stopped' }); await h.tick()
    expect(h.stream.agents()).toHaveLength(1)
    release(); await h.tick(); await h.tick()
    expect(h.edits.at(-1)?.text).toContain('⏹ Stopped after')
    expect(h.edits.at(-1)?.id).toBe(7)
    expect(h.stream.agents()).toEqual([])
  })

  test('an agent starting during the final edit keeps the group open', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h, 'first')); await h.tick()
    const release = h.holdEdit()
    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'first' }); await h.tick()
    h.events.push(start(h, 'second')); await h.tick()
    release(); await h.tick()
    h.advance(CHAT_GAP_MS); await h.tick()
    expect(h.sent).toHaveLength(1)
    expect(h.edits.at(-1)?.text).toContain('1. ✅ Done in')
    expect(h.edits.at(-1)?.text).toContain('2. ⏳')
    expect(h.stream.agents().map(a => a.id)).toEqual(['second'])
  })

  test('a resumed agent reuses its row while another agent keeps the group open', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h, 'resume'), start(h, 'running')); await h.tick()
    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'resume', outcome: 'stopped' }); await h.tick()
    expect(h.edits.at(-1)?.text).toContain('1. ⏹ Stopped after')
    h.advance(CHAT_GAP_MS)
    h.events.push(start(h, 'resume')); await h.tick()
    expect(h.edits.at(-1)?.text).toContain('1. ⏳')
    expect(h.edits.at(-1)?.text).not.toContain('Stopped')
    expect(h.edits.at(-1)?.text.split('\n')).toHaveLength(3)
    expect(h.sent).toHaveLength(1)
  })

  test('agents remain in the chat where they started while new agents can use another chat', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h, 'first')); await h.tick()
    h.setChat('84')
    h.events.push(start(h, 'second')); await h.tick()
    expect(h.sent.map(s => s.chat)).toEqual(['42', '84'])
    expect(h.sent.every(s => s.text.split('\n').length === 2)).toBe(true)
  })

  test('long Unicode labels and steps stay within one Telegram message without splitting emoji', async () => {
    const h = harness()
    await h.tick()
    for (let i = 0; i < 60; i++) {
      const id = `a${i}`
      h.events.push(start(h, id, { agent_type: 'type\n'.repeat(100) }))
      h.write(`/s/agent-${id}.meta.json`, JSON.stringify({ description: '😀'.repeat(100) }))
      h.write(`/s/agent-${id}.jsonl`, assistant([{ type: 'tool_use', name: 'Bash', input: { description: '😀'.repeat(100) } }]))
    }
    await h.tick()
    const text = h.sent[0]!.text
    expect(text.length).toBeLessThanOrEqual(AGENT_MESSAGE_LIMIT)
    expect(text.split('\n')).toHaveLength(61)
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
    expect(h.sent).toHaveLength(1)
  })

  test('an oversized group summarizes overflow and still acknowledges every terminal row', async () => {
    const h = harness()
    await h.tick()
    for (let i = 0; i < 150; i++) h.events.push(start(h, `a${i}`))
    await h.tick()
    expect(h.sent[0]!.text.length).toBeLessThanOrEqual(AGENT_MESSAGE_LIMIT)
    expect(h.sent[0]!.text).toContain('… 50 more agents')
    h.advance(CHAT_GAP_MS)
    h.events.push(start(h, 'new'))
    h.write('/s/agent-new.meta.json', JSON.stringify({ description: 'New arrival' }))
    await h.tick()
    expect(h.edits.at(-1)?.text).toContain('New arrival')
    h.advance(CHAT_GAP_MS)
    for (const a of h.stream.agents()) h.events.push({ t: h.now(), event: 'stop', agent_id: a.id, outcome: 'stopped' })
    for (let i = 0; i < 4; i++) { await h.tick(); h.advance(CHAT_GAP_MS) }
    expect(h.stream.agents()).toEqual([])
    expect(h.sent).toHaveLength(1)
    expect(h.edits.every(e => e.text.length <= AGENT_MESSAGE_LIMIT)).toBe(true)
  })

  test('a rate limit holds the chat for retry_after', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h))
    await h.tick()
    h.failEditWith({ description: 'Too Many Requests', parameters: { retry_after: 20 } })
    h.advance(CHAT_GAP_MS); await h.tick()
    h.failEditWith(undefined)
    h.advance(15_000); await h.tick()
    expect(h.edits).toEqual([])
    h.advance(10_000); await h.tick()
    expect(h.edits.length).toBe(1)
  })

  // The hold the server's flood watch sets on a chat after a 429 any call got
  // there (see flood.ts): every point that takes a slot in that chat waits for
  // its end, the stream's own spacing aside.
  test('a held chat gets no first send and no clock edit until its hold ends, then the current frame', async () => {
    const h = harness('1001')
    await h.tick()
    h.holdChat('1001', h.now() + 30_000)
    h.events.push(start(h))
    await h.tick()
    for (let i = 0; i < 9; i++) { h.advance(AGENT_TICK_MS); await h.tick() }
    expect(h.sent).toEqual([])
    h.advance(AGENT_TICK_MS); await h.tick()
    expect(h.sent).toEqual([{ chat: '1001', text: '🤖 Subagents\n1. ⏳ general-purpose · Starting… · 30s' }])
    h.holdChat('1001', h.now() + 25_000)
    for (let i = 0; i < 8; i++) { h.advance(AGENT_TICK_MS); await h.tick() }
    expect(h.edits).toEqual([])
    h.advance(1_000); await h.tick()
    expect(h.edits).toEqual([{ id: 7, text: '🤖 Subagents\n1. ⏳ general-purpose · Starting… · 55s' }])
  })

  test('a late stop\'s edit in a held chat waits for the hold to end', async () => {
    const h = harness('1001')
    await h.tick()
    h.events.push(start(h, 'a1'))
    h.write('/s/agent-a1.jsonl', line(userText('u-a1', h.now(), 'Job')))
    await h.tick()
    h.advance(CHAT_GAP_MS)
    h.write('/s/agent-a1.jsonl', line(userText('u-a1', h.now() - CHAT_GAP_MS, 'Job')) + line(apiError('e-a1', h.now(), 'overloaded')))
    await h.tick()
    expect(h.edits.at(-1)).toEqual({ id: 7, text: '🤖 Subagents\n1. ❌ Failed after 12s (overloaded) · general-purpose' })
    // The next tick confirms the failure and ends the group.
    h.advance(CHAT_GAP_MS); await h.tick()
    h.advance(CHAT_GAP_MS)
    const edits = h.edits.length
    h.holdChat('1001', h.now() + 20_000)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a1' })
    await h.tick()
    for (let i = 0; i < 6; i++) { h.advance(AGENT_TICK_MS); await h.tick() }
    expect(h.edits.length).toBe(edits)
    h.advance(2_000); await h.tick()
    expect(h.edits.slice(edits)).toEqual([{ id: 7, text: '🤖 Subagents\n1. ✅ Done in 36s · general-purpose' }])
  })

  test('the sweep of a gone server\'s message takes no slot in a held chat until the hold ends', async () => {
    const taken: number[] = []
    const h = harness('1001')
    h.sweepWith(slots => { if (slots.take('1001')) taken.push(slots.now()) })
    h.holdChat('1001', h.now() + 10_000)
    await h.tick()
    for (let i = 0; i < 3; i++) { h.advance(AGENT_TICK_MS); await h.tick() }
    expect(taken).toEqual([])
    h.advance(1_000); await h.tick()
    expect(taken).toEqual([h.now()])
  })

  test('the closing edit waits for a held chat, reads the hold again after its wait, and is not made when the hold runs past its time limit', async () => {
    // A hold past the limit: no closing edit, and the record keeps the
    // close-time text for the next server.
    const past = harness('1001')
    await past.tick()
    past.events.push(start(past)); await past.tick()
    past.advance(CHAT_GAP_MS)
    past.holdChat('1001', past.now() + 20_000)
    const before = past.records.length
    await past.stream.close(past.now() + CHAT_GAP_MS)
    expect(past.attempts).toEqual([])
    expect(past.records.slice(before).map(r => r.op)).toEqual(['write'])

    // A hold that ends within the limit, after the chat's own spacing: the
    // edit goes as it ends.
    const within = harness('1001')
    await within.tick()
    within.events.push(start(within)); await within.tick()
    const sentAt = within.now()
    within.holdChat('1001', sentAt + CHAT_GAP_MS + 1_000)
    await within.stream.close(sentAt + CHAT_GAP_MS + 2_000)
    expect(within.attempts.map(a => a.at)).toEqual([sentAt + CHAT_GAP_MS + 1_000])

    // A hold set while the closing edit waits for the chat's spacing, past
    // the limit: the edit is not made.
    const during = harness('1001')
    await during.tick()
    during.events.push(start(during)); await during.tick()
    during.afterSleep(() => during.holdChat('1001', during.now() + 20_000))
    await during.stream.close(during.now() + CHAT_GAP_MS)
    expect(during.attempts).toEqual([])
  })

  test('"message is not modified" counts as sent; a deleted panel is replaced', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h))
    await h.tick()
    h.failEditWith({ description: 'Bad Request: message is not modified' })
    h.advance(CLOCK_REFRESH_MS); await h.tick()
    h.failEditWith({ description: 'Bad Request: message to edit not found' })
    h.advance(CLOCK_REFRESH_MS); await h.tick()
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a1' })
    await h.tick()
    expect(h.stream.agents()).toHaveLength(1)
    h.failEditWith(undefined)
    h.advance(CHAT_GAP_MS); await h.tick()
    expect(h.sent).toHaveLength(2)
    expect(h.sent.at(-1)?.text).toContain('✅ Done in')
    expect(h.stream.agents()).toEqual([])
  })

  test('a quiet subagent shows as quiet, never as done, and its late stop still closes it', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h))
    await h.tick()
    h.advance(AGENT_STALE_MS + 1); await h.tick()
    expect(h.edits.at(-1)?.text).toContain('⚠️ No activity for 30m')
    expect(h.edits.at(-1)?.text).not.toContain('Done')
    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a1' })
    await h.tick()
    expect(h.edits.at(-1)?.text).toContain('✅ Done in 30m')
  })

  test('a stop read before its start still closes the subagent', async () => {
    const h = harness()
    await h.tick()
    const s = start(h)
    h.advance(500)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a1' }, s)
    await h.tick()
    expect(h.sent.at(-1)?.text).toContain('✅ Done in 0s')
    await h.tick()
    expect(h.stream.agents()).toEqual([])
  })

  test('streams nothing without a chat, and picks one up once someone writes', async () => {
    const h = harness(null)
    await h.tick()
    h.events.push(start(h))
    await h.tick()
    expect(h.sent).toEqual([])
    h.setChat('42')
    h.advance(1000); await h.tick()
    expect(h.sent.length).toBe(1)
  })

  test('a TaskStop read before its start keeps the stopped outcome', async () => {
    const h = harness()
    await h.tick()
    const s = start(h)
    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a1', outcome: 'stopped' }, s)
    await h.tick()
    expect(h.sent.at(-1)?.text).toContain('⏹ Stopped after 12s')
  })

  test('the backlog keeps only subagents still running', async () => {
    const h = harness()
    h.events.push(start(h, 'finished'), { t: h.now(), event: 'stop', agent_id: 'finished' }, start(h, 'running'))
    await h.tick()
    expect(h.stream.agents().map(a => a.id)).toEqual(['running'])
  })

  test('interrupted agents in the startup backlog are not announced as running', async () => {
    const h = harness()
    h.events.push(start(h))
    h.write('/s/agent-a1.jsonl', interrupted(h.now()))
    await h.tick()
    expect(h.sent).toEqual([])
    expect(h.stream.agents()).toEqual([])
  })

  // A workflow subagent's start event as the hook records it, and the run
  // folder its files are in.
  const WORKFLOW_SESSION = '/p/sess-w'
  const RUN_DIR = `${WORKFLOW_SESSION}/subagents/workflows/${WORKFLOW_RUN}`
  const workflowStart = (h: { now(): number }, id: string, agentType?: string) =>
    eventFromHook(workflowStartInput(id, `${WORKFLOW_SESSION}.jsonl`, agentType), h.now())!

  test('a workflow subagent shows its label once its meta file appears in its run folder, then its step and tokens', async () => {
    const h = harness()
    await h.tick()
    const ev = workflowStart(h, 'w1')
    expect(ev.agent_base).toBe(`${WORKFLOW_SESSION}/subagents/agent-w1`)
    h.events.push(ev)
    await h.tick()
    expect(h.sent.map(s => s.text)).toEqual(['🤖 Subagents\n1. ⏳ workflow-subagent · Starting… · 0s'])

    h.advance(CHAT_GAP_MS)
    h.write(`${RUN_DIR}/agent-w1.meta.json`, workflowMeta('check:one'))
    await h.tick()
    expect(h.edits.at(-1)).toEqual({ id: 7, text: '🤖 Subagents\n1. ⏳ workflow-subagent · check:one · Starting… · 12s' })

    h.advance(CHAT_GAP_MS)
    h.write(`${RUN_DIR}/agent-w1.jsonl`, toolCall(h.now(), 'Read the file', 32300))
    await h.tick()
    expect(h.edits.at(-1)).toEqual({ id: 7, text: '🤖 Subagents\n1. ⏳ workflow-subagent · check:one · Read the file · 24s · 32.3k tokens' })
  })

  test('a workflow subagent of a custom type is found in its run folder too', async () => {
    const h = harness()
    await h.tick()
    h.events.push(workflowStart(h, 'w6', 'code-reviewer'))
    h.write(`${RUN_DIR}/agent-w6.meta.json`, workflowMeta('review:six', 'code-reviewer'))
    h.write(`${RUN_DIR}/agent-w6.jsonl`, toolCall(h.now(), 'Read the diff', 2000))
    await h.tick()
    expect(h.sent.map(s => s.text)).toEqual(['🤖 Subagents\n1. ⏳ code-reviewer · review:six · Read the diff · 0s · 2.0k tokens'])
  })

  test('a workflow subagent whose transcript keeps changing never shows as quiet', async () => {
    const h = harness()
    await h.tick()
    h.events.push(workflowStart(h, 'w1'))
    h.write(`${RUN_DIR}/agent-w1.meta.json`, workflowMeta('check:one'))
    await h.tick()
    for (let i = 1; i <= 40; i++) {
      h.advance(60_000)
      h.write(`${RUN_DIR}/agent-w1.jsonl`, toolCall(h.now(), `Step ${i}`, 1000 + i))
      await h.tick()
    }
    expect([...h.sent.map(s => s.text), ...h.edits.map(e => e.text)].filter(text => text.includes('No activity'))).toEqual([])
    expect(h.edits.at(-1)?.text).toBe('🤖 Subagents\n1. ⏳ workflow-subagent · check:one · Step 40 · 40m 0s · 1.0k tokens')
  })

  test('a stopped workflow closes each of its rows from the stop line in its own transcript', async () => {
    const h = harness()
    await h.tick()
    for (const id of ['w1', 'w2']) {
      h.events.push(workflowStart(h, id))
      h.write(`${RUN_DIR}/agent-${id}.meta.json`, workflowMeta(`check:${id}`))
      h.write(`${RUN_DIR}/agent-${id}.jsonl`, toolCall(h.now(), 'Work', 100))
    }
    await h.tick()
    expect(h.sent.map(s => s.text)).toEqual(['🤖 Subagents\n'
      + '1. ⏳ workflow-subagent · check:w1 · Work · 0s · 100 tokens\n2. ⏳ workflow-subagent · check:w2 · Work · 0s · 100 tokens'])

    h.advance(21_000)
    h.write(`${RUN_DIR}/agent-w1.jsonl`, toolCall(h.now() - 1000, 'Work', 100) + '\n' + interrupted(h.now()))
    h.write(`${RUN_DIR}/agent-w2.jsonl`, toolCall(h.now() - 1000, 'Work', 100) + '\n' + interrupted(h.now(), true))
    await h.tick()
    expect(h.edits.at(-1)).toEqual({ id: 7, text: '🤖 Subagents\n'
      + '1. ⏹ Stopped after 21s · workflow-subagent · check:w1 · 100 tokens\n2. ⏹ Stopped after 21s · workflow-subagent · check:w2 · 100 tokens' })
    expect(h.stream.agents()).toEqual([])
  })

  test('a workflow subagent stopped before the server started is not announced', async () => {
    const h = harness()
    h.events.push(workflowStart(h, 'w4'))
    h.write(`${RUN_DIR}/agent-w4.meta.json`, workflowMeta('check:four'))
    h.write(`${RUN_DIR}/agent-w4.jsonl`, toolCall(h.now(), 'Work', 100) + '\n' + interrupted(h.now() + 5000))
    h.advance(60_000)
    await h.tick()
    expect(h.sent).toEqual([])
    expect(h.stream.agents()).toEqual([])
  })

  // A finished row leaves the message five minutes after the first edit
  // Telegram accepted with its ending.
  const FIVE_MINUTES = 5 * 60 * 1000
  const stopOf = (h: { now(): number }, id: string, outcome?: 'stopped'): AgentEvent =>
    ({ t: h.now(), event: 'stop', agent_id: id, ...(outcome ? { outcome } : {}) })
  const settled = () => new Promise(r => setTimeout(r, 0))
  // Ticks on the beat of the clock refresh, landing on `until`.
  async function runTo(h: ReturnType<typeof harness>, until: number) {
    while (h.now() < until) { h.advance(Math.min(BEAT_MS, until - h.now())); await h.tick() }
  }
  // Runs the clock to five minutes after `from`, with a tick a second before.
  async function runPast(h: ReturnType<typeof harness>, from: number) {
    await runTo(h, from + FIVE_MINUTES - 1000)
    await runTo(h, from + FIVE_MINUTES)
  }
  // The edits Telegram took, with the clock when each went out.
  const taken = (h: ReturnType<typeof harness>) => h.attempts.filter(e => e.error === undefined)
  // A row is in every taken edit from `since` until five minutes after
  // `from`, and gone from the first taken edit after that.
  function expectLeaves(h: ReturnType<typeof harness>, label: string, from: number, since = from) {
    const kept = taken(h).filter(e => e.at >= since && e.at < from + FIVE_MINUTES)
    expect(kept.length).toBeGreaterThanOrEqual(10)
    for (const e of kept) expect(e.text).toContain(label)
    const next = taken(h).find(e => e.at >= from + FIVE_MINUTES)
    expect(next).toBeDefined()
    expect(next!.at).toBeLessThanOrEqual(from + FIVE_MINUTES + BEAT_MS)
    expect(next!.text).not.toContain(label)
  }

  test('each kind of finished row leaves five minutes after the first accepted edit that showed it finished, while running and quiet rows stay', async () => {
    const h = harness()
    await h.tick()
    const t0 = h.now()
    h.events.push(start(h, 'idle', { agent_type: 'Idle-agent' }), shell(h, 'wait', 'Wait for deploy'))
    h.write('/t/wait.output', '')
    await h.tick()
    h.advance(60 * 60 * 1000)
    h.events.push(start(h, 'quiet', { agent_type: 'Quiet-agent' }))
    await h.tick()
    h.advance(AGENT_DROP_MS - 62 * 60 * 1000)
    const joined = h.now()
    h.events.push(start(h, 'done', { agent_type: 'Done-agent' }), start(h, 'halt', { agent_type: 'Halted-agent' }),
      shell(h, 'ok', 'Build docs'), shell(h, 'bad', 'Lint'))
    h.write('/t/ok.output', '')
    h.write('/t/bad.output', '')
    await h.tick()
    // The endings reach the chat 20 seconds apart; the idle subagent is
    // dropped after them, at the first tick past two hours without activity.
    h.advance(20_000); h.events.push(stopOf(h, 'done')); await h.tick()
    h.advance(20_000); h.write('/t/ok.output', 'built\n\n[exited with code 0]\n'); await h.tick()
    h.advance(20_000); h.events.push(stopOf(h, 'halt', 'stopped')); await h.tick()
    h.advance(20_000); h.write('/t/bad.output', '\n[exited with code 1]\n'); await h.tick()
    for (const d of [20_000, 40_000, 60_000, 80_000, 128_000]) await runPast(h, joined + d)
    await runTo(h, t0 + AGENT_DROP_MS + 6 * 60 * 1000)

    for (const e of taken(h).filter(e => e.at >= joined)) {
      expect(e.text).toContain('\n2. ⏳ shell · Wait for deploy · ')
      expect(e.text).toMatch(/\n3\. ⚠️ No activity for [^\n]+ · Quiet-agent · last: Starting…/)
    }

    const firstShowing = (line: string) => taken(h).find(e => e.text.includes(line))!.at
    const rows = [
      { label: 'Done-agent', from: firstShowing('\n4. ✅ Done in 20s · Done-agent') },
      { label: 'Build docs', from: firstShowing('\n6. ✅ Done in 40s · shell · Build docs') },
      { label: 'Halted-agent', from: firstShowing('\n5. ⏹ Stopped after 1m 0s · Halted-agent') },
      { label: 'Lint', from: firstShowing('\n7. ❌ Failed after 1m 20s (exit 1) · shell · Lint') },
      // Its line reads quiet before and after the drop.
      { label: 'Idle-agent', from: taken(h).find(e => e.at > t0 + AGENT_DROP_MS)!.at },
    ]
    expect(rows.map(r => r.from)).toEqual([20_000, 40_000, 60_000, 80_000, 128_000].map(d => joined + d))
    expect(taken(h).find(e => e.at === rows[4]!.from)!.text).toContain('\n1. ⚠️ No activity for 2h 0m · Idle-agent')
    for (const { label, from } of rows) expectLeaves(h, label, from, joined)

    expect(h.edits.at(-1)!.text).toBe('🤖 Subagents · 🐚 Shells\n2. ⏳ shell · Wait for deploy · 2h 5m\n'
      + '3. ⚠️ No activity for 1h 5m · Quiet-agent · last: Starting…')
  })

  test('an ending read while an edit is in flight, whose first edit a rate limit holds off a minute, leaves five minutes after the edit that carries it', async () => {
    const h = harness()
    await h.tick()
    h.events.push(shell(h, 'wait', 'Wait for deploy'), start(h, 'a1', { agent_type: 'Ending-agent' }))
    h.write('/t/wait.output', '')
    await h.tick()
    const release = h.holdEdit()
    h.advance(BEAT_MS); await h.tick()
    h.advance(CHAT_GAP_MS)
    h.events.push(stopOf(h, 'a1')); await h.tick()
    release(); await settled()
    expect(h.attempts).toHaveLength(1)
    expect(h.attempts[0]!.text).toContain('\n2. ⏳ Ending-agent · Starting… · 12s')

    h.failEditWith({ description: 'Too Many Requests: retry after 60', parameters: { retry_after: 60 } })
    h.advance(CHAT_GAP_MS); await h.tick()
    h.failEditWith(undefined)
    const refused = h.attempts.at(-1)!
    expect(refused.text).toContain('\n2. ✅ Done in 24s · Ending-agent')
    expect(refused.error).toBeDefined()
    h.advance(30_000); await h.tick()
    expect(h.attempts.at(-1)).toBe(refused)
    h.advance(30_000); await h.tick()
    const carried = h.attempts.at(-1)!
    expect(carried.at).toBe(refused.at + 60_000)
    expect(carried.error).toBeUndefined()
    expect(carried.text).toContain('\n2. ✅ Done in 24s · Ending-agent')

    await runPast(h, carried.at)
    expectLeaves(h, 'Ending-agent', carried.at, h.attempts[0]!.at)
  })

  test('an ending whose first edit fails leaves five minutes after the edit that carries it', async () => {
    const h = harness()
    await h.tick()
    h.events.push(shell(h, 'wait', 'Wait for deploy'), start(h, 'a1', { agent_type: 'Ending-agent' }))
    h.write('/t/wait.output', '')
    await h.tick()
    h.advance(CHAT_GAP_MS)
    h.events.push(stopOf(h, 'a1'))
    h.failEditWith({ description: 'Bad Gateway' })
    await h.tick()
    h.failEditWith(undefined)
    expect(h.attempts.at(-1)!.text).toContain('\n2. ✅ Done in 12s · Ending-agent')
    h.advance(CHAT_GAP_MS); await h.tick()
    const carried = h.attempts.at(-1)!
    expect(carried.error).toBeUndefined()
    expect(carried.text).toContain('\n2. ✅ Done in 12s · Ending-agent')

    await runPast(h, carried.at)
    expectLeaves(h, 'Ending-agent', carried.at)
  })

  test('an ending first carried by an edit answered "message is not modified" leaves five minutes after that answer', async () => {
    const h = harness()
    await h.tick()
    h.events.push(shell(h, 'wait', 'Wait for deploy'), start(h, 'a1', { agent_type: 'Ending-agent' }))
    h.write('/t/wait.output', '')
    await h.tick()
    h.advance(CHAT_GAP_MS)
    h.events.push(stopOf(h, 'a1'))
    h.failEditWith({ description: 'Bad Request: message is not modified' })
    await h.tick()
    h.failEditWith(undefined)
    const answered = h.attempts.at(-1)!
    expect(answered.text).toContain('\n2. ✅ Done in 12s · Ending-agent')
    expect(h.edits).toEqual([])

    await runPast(h, answered.at)
    expect(taken(h)[0]!.at).toBe(answered.at + BEAT_MS)
    expectLeaves(h, 'Ending-agent', answered.at)
  })

  test('a subagent resumed while its finished row is in the message runs on under the same number past the old run\'s five minutes', async () => {
    const h = harness()
    await h.tick()
    h.events.push(shell(h, 'wait', 'Wait for deploy'), start(h, 'r1', { agent_type: 'Resumed-agent' }))
    h.write('/t/wait.output', '')
    await h.tick()
    h.advance(CHAT_GAP_MS)
    h.events.push(stopOf(h, 'r1')); await h.tick()
    const ended = h.attempts.at(-1)!
    expect(ended.text).toContain('\n2. ✅ Done in 12s · Resumed-agent')

    h.advance(60_000)
    h.events.push(start(h, 'r1', { agent_type: 'Resumed-agent' })); await h.tick()
    expect(h.edits.at(-1)!.text).toBe('🤖 Subagents · 🐚 Shells\n1. ⏳ shell · Wait for deploy · 1m 12s\n2. ⏳ Resumed-agent · Starting… · 0s')
    const resumedAt = h.now()
    await runTo(h, ended.at + FIVE_MINUTES + 60_000)
    const later = taken(h).filter(e => e.at > resumedAt)
    expect(later.some(e => e.at >= ended.at + FIVE_MINUTES)).toBe(true)
    for (const e of later) {
      expect(e.text).toMatch(/^🤖 Subagents · 🐚 Shells\n1\. ⏳ shell · Wait for deploy · [^\n]+\n2\. ⏳ Resumed-agent · Starting… · [^\n]+$/)
    }
  })

  test('a subagent resumed after its row left comes back running under its old number', async () => {
    const h = harness()
    await h.tick()
    h.events.push(shell(h, 'wait', 'Wait for deploy'), start(h, 'r1', { agent_type: 'Resumed-agent' }), shell(h, 'next', 'Package'))
    h.write('/t/wait.output', '')
    h.write('/t/next.output', '')
    await h.tick()
    h.advance(CHAT_GAP_MS)
    h.events.push(stopOf(h, 'r1')); await h.tick()
    const ended = h.attempts.at(-1)!
    expect(ended.text).toContain('\n2. ✅ Done in 12s · Resumed-agent')
    await runTo(h, ended.at + FIVE_MINUTES)
    expect(h.edits.at(-1)!.text).toBe('🐚 Shells\n1. ⏳ shell · Wait for deploy · 5m 12s\n3. ⏳ shell · Package · 5m 12s')

    h.advance(BEAT_MS)
    h.events.push(start(h, 'r1', { agent_type: 'Resumed-agent' })); await h.tick()
    expect(h.edits.at(-1)!.text).toBe('🤖 Subagents · 🐚 Shells\n1. ⏳ shell · Wait for deploy · 5m 24s\n'
      + '2. ⏳ Resumed-agent · Starting… · 0s\n3. ⏳ shell · Package · 5m 24s')
  })

  test('once row 1, the only subagent, and the highest-numbered row have left, the edit is the remaining shells under their numbers, and a new row takes one past the highest number given', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h, 'a1', { agent_type: 'Explore' }), shell(h, 's2', 'Second'), shell(h, 's3', 'Third'), shell(h, 's4', 'Fourth'))
    for (const id of ['s2', 's3', 's4']) h.write(`/t/${id}.output`, '')
    await h.tick()
    expect(h.sent[0]!.text).toBe('🤖 Subagents · 🐚 Shells\n1. ⏳ Explore · Starting… · 0s\n'
      + '2. ⏳ shell · Second · 0s\n3. ⏳ shell · Third · 0s\n4. ⏳ shell · Fourth · 0s')
    h.advance(CHAT_GAP_MS)
    h.events.push(stopOf(h, 'a1')); await h.tick()
    const firstEnded = h.now()
    await runTo(h, firstEnded + 50_000)
    h.advance(CLOCK_REFRESH_MS)
    h.write('/t/s4.output', '\n[exited with code 0]\n'); await h.tick()
    const lastEnded = h.now()
    expect(h.edits.at(-1)!.text).toContain('\n4. ✅ Done in 1m 12s · shell · Fourth')

    await runTo(h, firstEnded + FIVE_MINUTES)
    expect(h.edits.at(-1)!.text).toBe('🐚 Shells\n2. ⏳ shell · Second · 5m 12s\n3. ⏳ shell · Third · 5m 12s\n4. ✅ Done in 1m 12s · shell · Fourth')
    await runTo(h, lastEnded + FIVE_MINUTES - CLOCK_REFRESH_MS)
    const before = h.edits.length
    await runTo(h, lastEnded + FIVE_MINUTES)
    expect(h.edits).toHaveLength(before + 1)
    expect(h.edits.at(-1)!.text).toBe('🐚 Shells\n2. ⏳ shell · Second · 6m 12s\n3. ⏳ shell · Third · 6m 12s')

    h.advance(CHAT_GAP_MS)
    h.events.push(shell(h, 's5', 'Fifth'))
    h.write('/t/s5.output', '')
    await h.tick()
    expect(h.edits.at(-1)!.text).toBe('🐚 Shells\n2. ⏳ shell · Second · 6m 24s\n3. ⏳ shell · Third · 6m 24s\n5. ⏳ shell · Fifth · 0s')
    expect(h.sent).toHaveLength(1)
  })

  test('once 60 finished rows have left, a running row longer than a sixty-first of the message gets its whole line', async () => {
    const h = harness()
    await h.tick()
    for (let i = 0; i < 60; i++) { h.events.push(shell(h, `d${i}`, `Step ${i}`)); h.write(`/t/d${i}.output`, '') }
    const description = 'Compare the cache layer with the old storage notes and list each gap'
    h.events.push(start(h, 'long'))
    h.write('/s/agent-long.meta.json', JSON.stringify({ description }))
    await h.tick()
    h.advance(CHAT_GAP_MS)
    for (let i = 0; i < 60; i++) h.write(`/t/d${i}.output`, '\n[exited with code 0]\n')
    await h.tick()
    const ended = h.now()
    // With the 60 rows in the message, the running row's share cuts it short.
    expect(h.edits.at(-1)!.text.split('\n').at(-1)).toMatch(/^61\. ⏳ general-purpose · Compare[^\n]*…$/)

    await runTo(h, ended + FIVE_MINUTES)
    h.write('/s/agent-long.jsonl', assistant([{ type: 'tool_use', name: 'Read', input: { description: 'Reading the storage notes one section at a time' } }],
      { input_tokens: 85400 }))
    h.advance(BEAT_MS); await h.tick()
    const full = `61. ⏳ general-purpose · ${description} · Reading the storage notes one section at a time · 5m 24s · 85.4k tokens`
    expect(full.length).toBeGreaterThan(AGENT_MESSAGE_LIMIT / 61)
    expect(h.edits.at(-1)!.text).toBe(`🤖 Subagents\n${full}`)
  })

  test('when the last running row ends, the final message keeps the endings of its last five minutes, no edit follows, and the next row starts a new message', async () => {
    const h = harness()
    await h.tick()
    h.events.push(shell(h, 'e1', 'Early'), shell(h, 'e2', 'Recent'), shell(h, 'e3', 'Last'))
    for (const id of ['e1', 'e2', 'e3']) h.write(`/t/${id}.output`, '')
    await h.tick()
    const began = h.now()
    h.advance(CHAT_GAP_MS)
    h.write('/t/e1.output', '\n[exited with code 0]\n'); await h.tick()
    await runTo(h, began + 4 * 60 * 1000)
    h.advance(CHAT_GAP_MS)
    h.write('/t/e2.output', '\n[exited with code 0]\n'); await h.tick()
    await runTo(h, began + 6 * 60 * 1000)
    h.advance(CHAT_GAP_MS)
    h.write('/t/e3.output', '\n[exited with code 0]\n'); await h.tick()
    const final = h.edits.at(-1)!
    expect(final).toEqual({ id: 7, text: '🐚 Shells\n2. ✅ Done in 4m 12s · shell · Recent\n3. ✅ Done in 6m 12s · shell · Last' })

    const attempts = h.attempts.length
    await runTo(h, h.now() + 10 * 60 * 1000)
    expect(h.attempts).toHaveLength(attempts)
    expect(h.sent).toHaveLength(1)
    h.events.push(shell(h, 'e4', 'Next'))
    h.write('/t/e4.output', '')
    await h.tick()
    expect(h.sent.map(s => s.text)).toEqual([expect.anything(), '🐚 Shells\n1. ⏳ shell · Next · 0s'])
    expect(h.sent[1]!.chat).toBe(h.sent[0]!.chat)
    expect(h.edits.at(-1)).toBe(final)
  })

  test('with over 100 rows still in the message after its lowest-numbered rows left, the cap shows 100 of them in its order and counts only the rest, and a finished row it held out leaves five minutes after the edit that shows it', async () => {
    const h = harness()
    await h.tick()
    for (let i = 0; i < 110; i++) { h.events.push(shell(h, `s${i}`, `S${i}`)); h.write(`/t/s${i}.output`, '') }
    await h.tick()
    const began = h.now()
    h.advance(CHAT_GAP_MS)
    for (const i of [0, 1, 2]) h.write(`/t/s${i}.output`, '\n[exited with code 0]\n')
    await h.tick()
    const firstEnded = h.now()
    await runTo(h, began + 60_000)
    h.advance(CHAT_GAP_MS)
    for (let i = 3; i < 108; i++) h.write(`/t/s${i}.output`, '\n[exited with code 0]\n')
    await h.tick()
    const secondEnded = h.now()
    await runTo(h, firstEnded + FIVE_MINUTES)

    const next = taken(h).find(e => e.at >= firstEnded + FIVE_MINUTES)!
    expect(next.at).toBe(firstEnded + FIVE_MINUTES)
    expect(next.text.length).toBeLessThanOrEqual(AGENT_MESSAGE_LIMIT)
    const lines = next.text.split('\n')
    expect(lines[0]).toBe('🐚 Shells')
    // The running rows first, then the finished history by number.
    const numbers = lines.slice(1, -1).map(l => Number(l.split('.')[0]))
    expect(numbers).toEqual([...Array.from({ length: 98 }, (_, i) => i + 4), 109, 110])
    expect(lines.at(-1)).toBe('… 7 more shells')
    expect(lines[1]).toBe('4. ✅ Done in 1m 12s · shell · S3')
    expect(lines.at(-3)).toBe('109. ⏳ shell · S108 · 5m 12s')
    expect(lines.at(-2)).toBe('110. ⏳ shell · S109 · 5m 12s')
    expect(taken(h).some(e => e.at < next.at && e.text.includes('\n4. ✅ Done in 1m 12s · shell · S3'))).toBe(true)

    // Rows 104 to 108 ended with the rest, but the cap held them out of that
    // edit; their five minutes start from the edit that shows them.
    const shownAll = taken(h).find(e => e.at > secondEnded)!
    expect(taken(h).find(e => e.at === secondEnded)!.text).not.toContain('\n104. ')
    expect(shownAll.text).toContain('\n108. ✅ Done in 1m 12s · shell · S107')
    await runPast(h, secondEnded)
    expect(taken(h).find(e => e.at >= secondEnded + FIVE_MINUTES)!.text).toContain('\n104. ✅ Done in 1m 12s · shell · S103')
    await runPast(h, shownAll.at)
    expect(taken(h).find(e => e.at >= shownAll.at + FIVE_MINUTES)!.text).not.toContain('\n104. ')
  })

  test('an ending first carried by the first send leaves five minutes after that send', async () => {
    const h = harness()
    await h.tick()
    h.events.push(shell(h, 'wait', 'Wait for deploy'), shell(h, 'quick', 'Quick check'))
    h.write('/t/wait.output', '')
    h.write('/t/quick.output', '\n[exited with code 0]\n')
    await h.tick()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.text).toContain('\n2. ✅ Done in 0s · shell · Quick check')
    const sentAt = h.now()
    await runPast(h, sentAt)
    expectLeaves(h, 'Quick check', sentAt)
  })

  test('a finished row whose tokens change while the edit carrying its ending is in flight leaves five minutes after that edit', async () => {
    const h = harness()
    await h.tick()
    h.events.push(shell(h, 'wait', 'Wait for deploy'), start(h, 'a1', { agent_type: 'Ending-agent' }))
    h.write('/t/wait.output', '')
    await h.tick()
    h.advance(CHAT_GAP_MS)
    h.events.push(stopOf(h, 'a1'))
    const release = h.holdEdit()
    await h.tick()
    expect(h.attempts.at(-1)!.text).toContain('\n2. ✅ Done in 12s · Ending-agent')
    h.advance(1000)
    h.write('/s/agent-a1.jsonl', assistant([{ type: 'text', text: 'All done' }], { input_tokens: 1200 }))
    await h.tick()
    const answeredAt = h.now()
    release(); await settled()
    await runPast(h, answeredAt)
    expect(taken(h).some(e => e.at > answeredAt && e.text.includes('Ending-agent · 1.2k tokens'))).toBe(true)
    expectLeaves(h, 'Ending-agent', answeredAt)
  })

  test('a subagent that fails on an API error closes as failed with its error class on the next tick', async () => {
    const h = harness()
    await h.tick()
    h.write('/s/agent-a1.meta.json', JSON.stringify({ description: 'Review the plan' }))
    h.events.push(start(h))
    await h.tick()
    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a1', outcome: 'failed', error: 'rate_limit' })
    await h.tick()
    expect(h.edits.at(-1)).toEqual({ id: 7, text: '🤖 Subagents\n1. ❌ Failed after 12s (rate_limit) · general-purpose · Review the plan' })
    await h.tick()
    expect(h.stream.agents()).toEqual([])
  })

  test('a failure read before its start keeps the failed outcome, and one with no error class reads as failed alone', async () => {
    const h = harness()
    await h.tick()
    const early = start(h, 'early')
    const plain = start(h, 'plain')
    h.advance(500)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'early', outcome: 'failed', error: 'server_error' }, early, plain,
      { t: h.now(), event: 'stop', agent_id: 'plain', outcome: 'failed' })
    await h.tick()
    expect(h.sent.at(-1)?.text).toBe('🤖 Subagents\n1. ❌ Failed after 0s (server_error) · general-purpose\n2. ❌ Failed after 0s · general-purpose')
  })

  test('the closing edit marks running rows as no longer followed and leaves a finished row as it was, and nothing follows it', async () => {
    const h = harness()
    await h.tick()
    h.write('/s/agent-run.meta.json', JSON.stringify({ description: 'Long job' }))
    h.write('/s/agent-quiet.meta.json', JSON.stringify({ description: 'Quiet job' }))
    h.events.push(start(h, 'quiet'))
    await h.tick()
    h.advance(AGENT_STALE_MS + 1000)
    h.events.push(start(h, 'run'), start(h, 'fin'), shell(h, 'b1', 'Wait for CI'))
    h.write('/s/agent-run.jsonl', toolCall(h.now(), 'Checking gate', 1500))
    await h.tick()
    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'fin' })
    await h.tick()
    const before = h.edits.at(-1)!.text.split('\n')
    expect(before[3]).toBe('3. ✅ Done in 12s · general-purpose')
    h.advance(1000)
    const edits = h.attempts.length
    await h.stream.close(h.now() + CHAT_GAP_MS)
    expect(h.attempts).toHaveLength(edits + 1)
    expect(h.edits.at(-1)!.text.split('\n')).toEqual([
      '🤖 Subagents · 🐚 Shells',
      '1. 🔌 No longer followed after 30m 14s · general-purpose · Quiet job · last: Starting…',
      '2. 🔌 No longer followed after 13s · general-purpose · Long job · last: Checking gate · 1.5k tokens',
      before[3],
      '4. 🔌 No longer followed after 13s · shell · Wait for CI',
    ])
    h.advance(CLOCK_REFRESH_MS); await h.tick()
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'run' })
    h.advance(CLOCK_REFRESH_MS); await h.tick()
    expect(h.attempts).toHaveLength(edits + 1)
    expect(h.sent).toHaveLength(1)
  })

  test('an ending that comes after the last tick shows in the closing edit as finished', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h, 'run'), start(h, 'fin'))
    await h.tick()
    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'fin' })
    await h.stream.close(h.now() + CHAT_GAP_MS)
    expect(h.edits).toEqual([{ id: 7, text: '🤖 Subagents\n1. 🔌 No longer followed after 12s · general-purpose · last: Starting…\n2. ✅ Done in 12s · general-purpose' }])
  })

  test('the closing edit waits for an edit in flight, then for the chat\'s next slot', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h))
    await h.tick()
    const release = h.holdEdit()
    h.advance(BEAT_MS); await h.tick()
    const inflight = h.attempts.at(-1)!.at
    const closed = h.stream.close(h.now() + CHAT_GAP_MS)
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
    expect(h.attempts).toHaveLength(1)
    release()
    await closed
    expect(h.attempts).toHaveLength(2)
    expect(h.attempts[1]!.at).toBe(inflight + CHAT_GAP_MS)
    expect(h.attempts[1]!.text).toBe('🤖 Subagents\n1. 🔌 No longer followed after 12s · general-purpose · last: Starting…')
  })

  test('the closing edit waits for the first send in flight and edits the message it made', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h))
    const release = h.holdSend()
    await h.tick()
    const sentAt = h.now()
    h.advance(1000)
    const closed = h.stream.close(h.now() + CHAT_GAP_MS)
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
    expect(h.attempts).toEqual([])
    release()
    await closed
    expect(h.edits).toEqual([{ id: 7, text: '🤖 Subagents\n1. 🔌 No longer followed after 1s · general-purpose · last: Starting…' }])
    expect(h.attempts[0]!.at).toBe(sentAt + CHAT_GAP_MS)
  })

  test('no closing send for a message never sent, no closing edit for a group whose last frame went out or is on its way, nor past the time limit', async () => {
    const unsent = harness()
    await unsent.tick()
    unsent.events.push(start(unsent))
    await unsent.stream.close(unsent.now() + CHAT_GAP_MS)
    expect(unsent.sent).toEqual([])
    expect(unsent.attempts).toEqual([])

    const ended = harness()
    await ended.tick()
    ended.events.push(start(ended)); await ended.tick()
    ended.advance(CHAT_GAP_MS)
    ended.events.push({ t: ended.now(), event: 'stop', agent_id: 'a1' }); await ended.tick()
    ended.advance(CHAT_GAP_MS)
    await ended.stream.close(ended.now() + CHAT_GAP_MS)
    expect(ended.attempts).toHaveLength(1)

    const final = harness()
    await final.tick()
    final.events.push(start(final)); await final.tick()
    final.advance(CHAT_GAP_MS)
    final.events.push({ t: final.now(), event: 'stop', agent_id: 'a1' })
    const release = final.holdEdit()
    await final.tick()
    const closed = final.stream.close(final.now() + CHAT_GAP_MS)
    release()
    await closed
    expect(final.attempts).toHaveLength(1)

    const held = harness()
    await held.tick()
    held.events.push(start(held)); await held.tick()
    held.failEditWith({ description: 'Too Many Requests', parameters: { retry_after: 20 } })
    held.advance(CLOCK_REFRESH_MS); await held.tick()
    held.failEditWith(undefined)
    await held.stream.close(held.now() + CHAT_GAP_MS)
    expect(held.attempts).toHaveLength(1)
  })

  test('a start that replaces a transcript-closed row from another chat keeps it in its own chat\'s message', async () => {
    const h = harness('1001')
    await h.tick()
    h.events.push(start(h))
    h.write('/s/agent-a1.jsonl', line(userText('u1', h.now(), 'Long job')))
    await h.tick()
    h.advance(CHAT_GAP_MS)
    h.write('/s/agent-a1.jsonl', line(userText('u1', h.now() - 3000, 'Long job')) + line(apiError('e1', h.now(), 'overloaded')))
    await h.tick()
    expect(h.edits.at(-1)!.text).toBe('🤖 Subagents\n1. ❌ Failed after 12s (overloaded) · general-purpose')
    // Another chat writes, and the run resumes before the failure is confirmed.
    h.setChat('2002')
    h.advance(CHAT_GAP_MS)
    h.events.push(start(h))
    h.write('/s/agent-a1.jsonl', line(apiError('e1', h.now() - 3000, 'overloaded')) + line(userText('u2', h.now(), 'Resume')))
    await h.tick()
    expect(h.edits.at(-1)!.text).toBe('🤖 Subagents\n1. ⏳ general-purpose · Starting… · 0s')
    for (let i = 0; i < 40; i++) { h.advance(CLOCK_REFRESH_MS); await h.tick() }
    expect(h.sent.map(m => m.chat)).toEqual(['1001'])
    expect(h.attempts.filter(a => a.text === '')).toEqual([])
    expect(new Set(h.edits.map(e => e.id))).toEqual(new Set([7]))
  })

  test('a group reopened for a late stop leaves a row a later start replaced where it was', async () => {
    const h = harness('1001')
    await h.tick()
    h.events.push(start(h, 'a1'), start(h, 'a3'))
    for (const id of ['a1', 'a3']) h.write(`/s/agent-${id}.jsonl`, line(userText(`u-${id}`, h.now(), 'Job')))
    await h.tick()
    h.advance(CHAT_GAP_MS)
    for (const id of ['a1', 'a3']) h.write(`/s/agent-${id}.jsonl`, line(apiError(`e-${id}`, h.now(), 'overloaded')))
    await h.tick()
    expect(h.edits.at(-1)!.text).toBe('🤖 Subagents\n1. ❌ Failed after 12s (overloaded) · general-purpose\n2. ❌ Failed after 12s (overloaded) · general-purpose')
    // The next tick confirms both failures and ends the group.
    h.advance(CHAT_GAP_MS); await h.tick()
    // a3 resumes and finishes in a new message.
    h.advance(CHAT_GAP_MS)
    h.write('/s/agent-a3.jsonl', line(apiError('e-a3', h.now() - 3000, 'overloaded')) + line(userText('r-a3', h.now(), 'Resume')))
    h.events.push(start(h, 'a3'))
    await h.tick()
    expect(h.sent.at(-1)).toEqual({ chat: '1001', text: '🤖 Subagents\n1. ⏳ general-purpose · Starting… · 0s' })
    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a3' })
    await h.tick()
    h.advance(CHAT_GAP_MS); await h.tick()
    // a1's late stop edits its message; the replaced a3 stays as it was there.
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a1' })
    await h.tick()
    expect(h.edits.at(-1)).toEqual({ id: 7, text: '🤖 Subagents\n1. ✅ Done in 1m 0s · general-purpose\n2. ❌ Failed after 12s (overloaded) · general-purpose' })
    h.write('/s/agent-a3.jsonl', line(userText('r-a3', h.now() - 2 * CHAT_GAP_MS, 'Resume')) + line(userText('n-a3', h.now(), 'More')))
    for (let i = 0; i < 4; i++) { h.advance(CHAT_GAP_MS); await h.tick() }
    expect(h.sent).toHaveLength(2)
  })

  test('a late stop while a newer group holds the chat edits the ended group\'s message at the chat\'s next slot, and the newer message keeps its own row', async () => {
    const h = harness('1001')
    await h.tick()
    h.events.push(start(h, 'a1'))
    h.write('/s/agent-a1.jsonl', line(userText('u-a1', h.now(), 'Job')))
    await h.tick()
    h.advance(CHAT_GAP_MS)
    h.write('/s/agent-a1.jsonl', line(userText('u-a1', h.now() - CHAT_GAP_MS, 'Job')) + line(apiError('e-a1', h.now(), 'overloaded')))
    await h.tick()
    expect(h.edits.at(-1)).toEqual({ id: 7, text: '🤖 Subagents\n1. ❌ Failed after 12s (overloaded) · general-purpose' })
    // The next tick confirms the failure and ends the group.
    h.advance(CHAT_GAP_MS); await h.tick()
    // a2 starts a new group in its own message, and a1's stop lands in that
    // same tick: the send took the chat's slot, so the late edit waits.
    h.advance(CHAT_GAP_MS)
    h.events.push(start(h, 'a2'))
    await h.tick()
    expect(h.sent.at(-1)).toEqual({ chat: '1001', text: '🤖 Subagents\n1. ⏳ general-purpose · Starting… · 0s' })
    const edits = h.edits.length
    const stopAt = h.now()
    h.events.push({ t: stopAt, event: 'stop', agent_id: 'a1' })
    await h.tick()
    expect(h.edits.length).toBe(edits)
    // a2 ends as the late edit takes the slot: a2's message waits for the next.
    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a2' })
    await h.tick()
    expect(h.edits.slice(edits)).toEqual([{ id: 7, text: '🤖 Subagents\n1. ✅ Done in 36s · general-purpose' }])
    // The record took the final frame at the stop, before the edit, and is
    // deleted once Telegram has it.
    const late = h.records.filter(r => r.id === 7 && r.at >= stopAt)
    expect(late[0]).toEqual({ at: stopAt, op: 'write', chat: '1001', id: 7, text: '🤖 Subagents\n1. ✅ Done in 36s · general-purpose' })
    expect(late.at(-1)).toMatchObject({ op: 'remove', id: 7 })
    for (let i = 0; i < 3; i++) { h.advance(CHAT_GAP_MS); await h.tick() }
    expect(h.edits.slice(edits)).toEqual([
      { id: 7, text: '🤖 Subagents\n1. ✅ Done in 36s · general-purpose' },
      { id: 8, text: '🤖 Subagents\n1. ✅ Done in 12s · general-purpose' },
    ])
    expect(h.sent).toHaveLength(2)
  })

  test('a row that goes on in a newer message keeps its earlier line in the ended group\'s message when a late stop edits it', async () => {
    const h = harness('1001')
    await h.tick()
    h.events.push(start(h, 'a1'), start(h, 'a2'))
    for (const id of ['a1', 'a2']) h.write(`/s/agent-${id}.jsonl`, line(userText(`u-${id}`, h.now(), 'Job')))
    await h.tick()
    h.advance(CHAT_GAP_MS)
    for (const id of ['a1', 'a2']) h.write(`/s/agent-${id}.jsonl`, line(userText(`u-${id}`, h.now() - CHAT_GAP_MS, 'Job')) + line(apiError(`e-${id}`, h.now(), 'overloaded')))
    await h.tick()
    h.advance(CHAT_GAP_MS); await h.tick()
    // a2's run goes on after the group ended: it returns in a new message.
    h.advance(CHAT_GAP_MS)
    h.write('/s/agent-a2.jsonl', line(apiError('e-a2', h.now() - 2 * CHAT_GAP_MS, 'overloaded')) + line(assistantText('t-a2', h.now(), 'Going on')))
    await h.tick()
    expect(h.sent).toHaveLength(2)
    expect(h.sent.at(-1)!.text).toMatch(/^🤖 Subagents\n1\. ⏳ general-purpose · /)
    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a1' })
    await h.tick()
    expect(h.edits.at(-1)).toEqual({ id: 7, text: '🤖 Subagents\n1. ✅ Done in 48s · general-purpose\n2. ❌ Failed after 12s (overloaded) · general-purpose' })
  })

  test('a late stop whose message is gone tries one edit, sends no new message and drops the record', async () => {
    const h = harness('1001')
    await h.tick()
    h.events.push(start(h, 'a1'))
    h.write('/s/agent-a1.jsonl', line(userText('u-a1', h.now(), 'Job')))
    await h.tick()
    h.advance(CHAT_GAP_MS)
    h.write('/s/agent-a1.jsonl', line(userText('u-a1', h.now() - CHAT_GAP_MS, 'Job')) + line(apiError('e-a1', h.now(), 'overloaded')))
    await h.tick()
    h.advance(CHAT_GAP_MS); await h.tick()
    const shown = h.attempts.length
    h.failEditWith({ description: 'Bad Request: message to edit not found' })
    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a1' })
    for (let i = 0; i < 5; i++) { await h.tick(); h.advance(CHAT_GAP_MS) }
    expect(h.attempts.slice(shown).map(a => a.text)).toEqual(['🤖 Subagents\n1. ✅ Done in 36s · general-purpose'])
    expect(h.sent).toHaveLength(1)
    expect(h.records.filter(r => r.id === 7).at(-1)).toMatchObject({ op: 'remove', id: 7 })
  })

  test('a late stop keeps the rest of the ended group\'s message as its last frame showed it, a row past its five minutes included', async () => {
    const h = harness('1001')
    await h.tick()
    h.events.push(start(h, 'a1'), start(h, 'a2'), { t: h.now(), event: 'stop', agent_id: 'a2' })
    h.write('/s/agent-a1.jsonl', line(userText('u-a1', h.now(), 'Job')))
    await h.tick()
    h.advance(CHAT_GAP_MS)
    h.write('/s/agent-a1.jsonl', line(userText('u-a1', h.now() - CHAT_GAP_MS, 'Job')) + line(apiError('e-a1', h.now(), 'overloaded')))
    await h.tick()
    // The next tick confirms the failure and ends the group.
    h.advance(CHAT_GAP_MS); await h.tick()
    expect(h.edits.at(-1)).toEqual({ id: 7, text: '🤖 Subagents\n1. ❌ Failed after 12s (overloaded) · general-purpose\n2. ✅ Done in 0s · general-purpose' })
    h.advance(FINISHED_ROW_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a1' })
    await h.tick()
    expect(h.edits.at(-1)).toEqual({ id: 7, text: '🤖 Subagents\n1. ✅ Done in 5m 24s · general-purpose\n2. ✅ Done in 0s · general-purpose' })
  })

  test('a stop for a watched row while its group is open shows in the next frame, and the row leaves five minutes after it', async () => {
    const h = harness('1001')
    await h.tick()
    h.events.push(start(h, 'a1'), start(h, 'a2'))
    for (const id of ['a1', 'a2']) h.write(`/s/agent-${id}.jsonl`, line(userText(`u-${id}`, h.now(), 'Job')))
    await h.tick()
    h.advance(CHAT_GAP_MS)
    h.write('/s/agent-a1.jsonl', line(userText('u-a1', h.now() - CHAT_GAP_MS, 'Job')) + line(apiError('e-a1', h.now(), 'overloaded')))
    await h.tick()
    expect(h.edits.at(-1)!.text.split('\n')[1]).toBe('1. ❌ Failed after 12s (overloaded) · general-purpose')
    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a1' })
    await h.tick()
    expect(h.edits.at(-1)!.text.split('\n')[1]).toBe('1. ✅ Done in 24s · general-purpose')
    // The clock refresh edits every ten seconds; the row is in each edit up
    // to five minutes after that frame, and out of the one at five minutes.
    for (let i = 1; i < FINISHED_ROW_MS / CLOCK_REFRESH_MS; i++) { h.advance(CLOCK_REFRESH_MS); await h.tick() }
    expect(h.edits.at(-1)!.text.split('\n')[1]).toBe('1. ✅ Done in 24s · general-purpose')
    h.advance(CLOCK_REFRESH_MS); await h.tick()
    expect(h.edits.at(-1)!.text).toMatch(/^🤖 Subagents\n2\. ⏳ /)
  })

  test('a start replaces a reopened row even once its error has left the transcript\'s tail', async () => {
    const h = harness('1001')
    await h.tick()
    h.events.push(start(h, 'a1'))
    h.write('/s/agent-a1.jsonl', line(userText('u-a1', h.now(), 'Job')))
    await h.tick()
    h.advance(CHAT_GAP_MS)
    h.write('/s/agent-a1.jsonl', line(userText('u-a1', h.now() - CHAT_GAP_MS, 'Job')) + line(apiError('e-a1', h.now(), 'overloaded')))
    await h.tick()
    expect(h.edits.at(-1)!.text).toBe('🤖 Subagents\n1. ❌ Failed after 12s (overloaded) · general-purpose')
    // The resumed prompt reopens the row; by the time its start is read, the
    // tail holds only entries newer than the error.
    h.advance(CHAT_GAP_MS)
    h.write('/s/agent-a1.jsonl', line(userText('r-a1', h.now(), 'Resume')))
    await h.tick()
    expect(h.edits.at(-1)!.text).toMatch(/^🤖 Subagents\n1\. ⏳ general-purpose · .* · 24s$/)
    h.advance(CHAT_GAP_MS)
    h.events.push(start(h, 'a1'))
    await h.tick()
    // The row reads the same apart from its clock, so the next clock refresh
    // shows it: on the resumed run's clock, not the first run's.
    h.advance(BEAT_MS); await h.tick()
    expect(h.edits.at(-1)!.text).toMatch(/^🤖 Subagents\n1\. ⏳ general-purpose · .* · 12s$/)
  })

  test('a group whose rows have all left the message ends without an edit', async () => {
    const h = harness('1001')
    await h.tick()
    h.events.push(start(h))
    h.write('/s/agent-a1.jsonl', line(userText('u1', h.now(), 'Long job')))
    await h.tick()
    h.advance(CHAT_GAP_MS)
    h.write('/s/agent-a1.jsonl', line(userText('u1', h.now() - 3000, 'Long job')) + line(apiError('e1', h.now(), 'overloaded')))
    await h.tick()
    const shown = h.attempts.length
    // From here on each read of the tail holds only request records.
    for (let i = 0; i < 40; i++) {
      h.advance(CLOCK_REFRESH_MS)
      h.write('/s/agent-a1.jsonl', line(requestBlob(100 + i)))
      await h.tick()
    }
    expect(h.attempts.slice(shown)).toEqual([])
    h.events.push(start(h, 'a2'))
    await h.tick()
    expect(h.sent.at(-1)).toEqual({ chat: '1001', text: '🤖 Subagents\n1. ⏳ general-purpose · Starting… · 0s' })
  })

  test('a late stop for a row of a group whose rows all left at once edits that message to done, with no empty frame', async () => {
    const h = harness('1001')
    await h.tick()
    h.events.push(start(h))
    h.write('/s/agent-a1.jsonl', line(userText('u1', h.now(), 'Long job')))
    await h.tick()
    h.advance(CHAT_GAP_MS)
    h.write('/s/agent-a1.jsonl', line(userText('u1', h.now() - 3000, 'Long job')) + line(apiError('e1', h.now(), 'overloaded')))
    await h.tick()
    const shown = h.attempts.length
    const recorded = h.records.length
    // From here on each read of the tail holds only request records, so the
    // failure is never confirmed, and the row leaves after five minutes.
    for (let i = 0; i < 40; i++) {
      h.advance(CLOCK_REFRESH_MS)
      h.write('/s/agent-a1.jsonl', line(requestBlob(100 + i)))
      await h.tick()
    }
    expect(h.attempts.slice(shown)).toEqual([])
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a1' })
    for (let i = 0; i < 6; i++) { await h.tick(); h.advance(CHAT_GAP_MS) }
    const late = h.attempts.slice(shown)
    expect(late).toHaveLength(1)
    expect(late[0]!.text).toMatch(/^🤖 Subagents\n1\. ✅ Done in /)
    expect(late[0]!.error).toBeUndefined()
    expect(h.edits.at(-1)!.id).toBe(7)
    expect(h.records.slice(recorded).filter(r => r.text === '')).toEqual([])
    expect(h.records.at(-1)).toMatchObject({ op: 'remove', chat: '1001', id: 7 })
  })

  describe('the records of open messages', () => {

    test('a record is written right after the first send and before each edit, with that frame\'s closing text, and deleted once the group\'s final frame is accepted', async () => {
      const h = harness('1001')
      await h.tick()
      h.events.push(start(h, 'run'), start(h, 'fin'))
      await h.tick()
      expect(h.records).toEqual([{ at: h.now(), op: 'write', chat: '1001', id: 7,
        text: '🤖 Subagents\n1. 🔌 No longer followed after 0s · general-purpose · last: Starting…\n2. 🔌 No longer followed after 0s · general-purpose · last: Starting…' }])
      h.advance(CHAT_GAP_MS)
      h.events.push({ t: h.now(), event: 'stop', agent_id: 'fin' })
      await h.tick()
      expect(h.records.at(-1)).toEqual({ at: h.now(), op: 'write', chat: '1001', id: 7,
        text: '🤖 Subagents\n1. 🔌 No longer followed after 12s · general-purpose · last: Starting…\n2. ✅ Done in 12s · general-purpose' })
      expect(h.attempts.at(-1)!.at).toBe(h.records.at(-1)!.at)
      h.advance(CHAT_GAP_MS)
      h.events.push({ t: h.now(), event: 'stop', agent_id: 'run' })
      await h.tick()
      expect(h.records.slice(-2).map(r => r.op)).toEqual(['write', 'remove'])
      expect(h.records.at(-1)).toMatchObject({ op: 'remove', chat: '1001', id: 7 })
    })

    test('the close rewrites the record with the close-time frame, and deletes it once the closing edit is accepted or not modified, never when refused', async () => {
      for (const answer of ['accepted', 'not modified', 'refused'] as const) {
        const h = harness('1001')
        await h.tick()
        h.events.push(start(h))
        await h.tick()
        h.advance(CHAT_GAP_MS + 2000)
        if (answer === 'not modified') h.failEditWith({ description: 'Bad Request: message is not modified' })
        if (answer === 'refused') h.failEditWith({ description: 'Too Many Requests: retry after 9', parameters: { retry_after: 9 } })
        const before = h.records.length
        await h.stream.close(h.now() + CHAT_GAP_MS)
        const after = h.records.slice(before)
        expect(after[0]).toEqual({ at: h.now(), op: 'write', chat: '1001', id: 7,
          text: '🤖 Subagents\n1. 🔌 No longer followed after 14s · general-purpose · last: Starting…' })
        expect(after.slice(1).map(r => r.op)).toEqual(answer === 'refused' ? [] : ['remove'])
      }
    })

    test('a replaced message\'s record is deleted, and the new message writes its own', async () => {
      const h = harness('1001')
      await h.tick()
      h.events.push(start(h))
      await h.tick()
      h.failEditWith({ description: 'Bad Request: message to edit not found' })
      h.advance(BEAT_MS); await h.tick()
      h.failEditWith(undefined)
      expect(h.records.at(-1)).toMatchObject({ op: 'remove', id: 7 })
      h.advance(CHAT_GAP_MS); await h.tick()
      expect(h.records.at(-1)).toMatchObject({ op: 'write', id: 8 })
    })

    test('a gone group\'s record takes its final frame when the group is dropped', async () => {
      const h = harness('1001')
      await h.tick()
      h.events.push(start(h, 'run'), start(h, 'fin'))
      await h.tick()
      h.failEditWith({ description: 'Bad Request: message thread not found' })
      for (let i = 0; i < 5; i++) { h.advance(BEAT_MS); await h.tick() }
      h.failEditWith(undefined)
      const tried = h.attempts.length
      h.advance(CHAT_GAP_MS)
      h.events.push({ t: h.now(), event: 'stop', agent_id: 'fin' }, { t: h.now(), event: 'stop', agent_id: 'run' })
      await h.tick()
      expect(h.attempts).toHaveLength(tried)
      expect(h.records.at(-1)).toEqual({ at: h.now(), op: 'write', chat: '1001', id: 7,
        text: '🤖 Subagents\n1. ✅ Done in 1m 12s · general-purpose\n2. ✅ Done in 1m 12s · general-purpose' })
    })

    test('a row dropped after two hours of quiet keeps its dropped line in the record, with its clock read to the close', async () => {
      const h = harness('1001')
      await h.tick()
      h.events.push(start(h, 'quiet'), start(h, 'run'))
      await h.tick()
      h.advance(AGENT_DROP_MS + 1000)
      h.write('/s/agent-run.jsonl', toolCall(h.now(), 'Checking gate', 1500))
      await h.tick()
      expect(h.edits.at(-1)!.text).toContain('1. ⚠️ No activity for 2h 0m')
      h.advance(60_000)
      const before = h.records.length
      await h.stream.close(h.now() + CHAT_GAP_MS)
      expect(h.records[before]).toEqual({ at: h.now(), op: 'write', chat: '1001', id: 7, text: '🤖 Subagents\n'
        + '1. ⚠️ No activity for 2h 1m · general-purpose · last: Starting…\n'
        + '2. 🔌 No longer followed after 2h 1m · general-purpose · last: Checking gate · 1.5k tokens' })
    })
  })
})

describe('hooks/subagent.ts', () => {
  test('appends the event to the file named for the Claude Code pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-'))
    const r = Bun.spawnSync(['bun', join(import.meta.dir, 'hooks', 'subagent.ts')], {
      stdin: new TextEncoder().encode(JSON.stringify({
        hook_event_name: 'SubagentStart',
        agent_id: 'a9',
        agent_type: 'Explore',
        transcript_path: '/p/sess.jsonl',
      })),
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, TELEGRAM_STATE_DIR: dir, CLAUDE_PID: '4242' },
    })
    expect(r.exitCode).toBe(0)
    const ev = JSON.parse(readFileSync(agentEventFile(dir, 4242), 'utf8').trim())
    expect(ev).toMatchObject({ event: 'start', agent_id: 'a9', agent_type: 'Explore', agent_base: '/p/sess/subagents/agent-a9' })
  })

  test('the registered TaskStop hook appends a successful stop with its outcome', () => {
    const hooks = JSON.parse(readFileSync(join(import.meta.dir, 'hooks', 'hooks.json'), 'utf8')).hooks
    expect(hooks.PostToolUse.some((h: { matcher: string }) => h.matcher === 'TaskStop')).toBe(true)
    const dir = mkdtempSync(join(tmpdir(), 'agents-'))
    const r = Bun.spawnSync(['bun', join(import.meta.dir, 'hooks', 'subagent.ts')], {
      stdin: new TextEncoder().encode(JSON.stringify({
        hook_event_name: 'PostToolUse', tool_name: 'TaskStop', tool_input: { task_id: 'a9' },
        tool_response: { task_id: 'a9', task_type: 'local_agent', message: 'Successfully stopped task: a9 (Review)' },
      })),
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, TELEGRAM_STATE_DIR: dir, CLAUDE_PID: '4242' },
    })
    expect(r.exitCode).toBe(0)
    const ev = JSON.parse(readFileSync(agentEventFile(dir, 4242), 'utf8').trim())
    expect(ev).toMatchObject({ event: 'stop', agent_id: 'a9', outcome: 'stopped' })
  })

  // The real hook, real files and the stream's own file readers: a background
  // shell recorded from Claude Code, then its exit code line.
  test('the registered Bash hook records a background shell that the stream follows to its exit code', async () => {
    const hooks = JSON.parse(readFileSync(join(import.meta.dir, 'hooks', 'hooks.json'), 'utf8')).hooks
    const bashHook = hooks.PostToolUse.find((h: { matcher: string }) => h.matcher === 'Bash')
    expect(bashHook.hooks).toMatchObject([{ command: 'bun "${CLAUDE_PLUGIN_ROOT}/hooks/subagent.ts"', async: true }])
    const dir = mkdtempSync(join(tmpdir(), 'agents-'))
    const tmp = mkdtempSync(join(tmpdir(), 'shell-tmp-'))
    const input = shellHooks.background_bash
    const tasks = join(tmp, `claude-${process.getuid?.() ?? 0}`, '-srv-probe-shell-probe-890-work', input.session_id, 'tasks')
    mkdirSync(tasks, { recursive: true })
    const output = join(tasks, 'bqo62tie2.output')
    writeFileSync(output, '')
    const run = (stdin: unknown) => Bun.spawnSync(['bun', join(import.meta.dir, 'hooks', 'subagent.ts')], {
      stdin: new TextEncoder().encode(JSON.stringify(stdin)),
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, TELEGRAM_STATE_DIR: dir, CLAUDE_PID: '4242', CLAUDE_CODE_TMPDIR: tmp },
    })
    const file = agentEventFile(dir, 4242)
    expect(run(shellHooks.foreground_bash).exitCode).toBe(0)
    expect(existsSync(file)).toBe(false)
    expect(run(input).exitCode).toBe(0)
    expect(run(shellHooks.task_stop_shell).exitCode).toBe(0)
    const events = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(events).toMatchObject([
      { event: 'shell_start', task_id: 'bqo62tie2', description: 'Probe failing shell', output: realpathSync(output) },
      { event: 'shell_stop', task_id: 'bm4vrn0w1', outcome: 'stopped' },
    ])
    expect(readFileSync(file, 'utf8')).not.toContain('sleep')

    let clock = Date.now()
    const sent: string[] = []
    const stream = createAgentStream({
      readEvents: createEventReader([file], false),
      chat: () => '42',
      send: async (_c, text) => { sent.push(text); return 7 },
      edit: async (_c, _id, text) => { sent.push(text) },
      now: () => clock,
    })
    stream.tick()
    await new Promise(r => setTimeout(r, 0))
    expect(sent).toEqual(['🐚 Shells\n1. ⏳ shell · Probe failing shell · 0s'])
    appendFileSync(output, 'out-a\n\n[exited with code 3]\n')
    clock += CHAT_GAP_MS
    stream.tick()
    await new Promise(r => setTimeout(r, 0))
    expect(sent.at(-1)).toMatch(/^🐚 Shells\n1\. ❌ Failed after \d+s \(exit 3\) · shell · Probe failing shell$/)
  })

  // The real hook, the subagents' files in Claude Code's own layout and the
  // stream's own file readers: a workflow of four subagents stopped by TaskStop.
  test('a stopped workflow through the hook: four SubagentStart inputs, a TaskStop result that appends nothing, then the stop lines close every row', async () => {
    const state = mkdtempSync(join(tmpdir(), 'agents-'))
    const projects = mkdtempSync(join(tmpdir(), 'projects-'))
    try {
      const { session_id } = workflowHooks.subagent_start_workflow
      const transcript = join(projects, `${session_id}.jsonl`)
      const runDir = join(projects, session_id, 'subagents', 'workflows', WORKFLOW_RUN)
      mkdirSync(runDir, { recursive: true })
      const hook = (stdin: unknown) => Bun.spawnSync(['bun', join(import.meta.dir, 'hooks', 'subagent.ts')], {
        stdin: new TextEncoder().encode(JSON.stringify(stdin)),
        env: { PATH: process.env.PATH!, HOME: process.env.HOME!, TELEGRAM_STATE_DIR: state, CLAUDE_PID: '4242' },
      })
      const file = agentEventFile(state, 4242)
      const ids = [1, 2, 3, 4].map(n => `${workflowHooks.subagent_start_workflow.agent_id.slice(0, -1)}${n}`)
      for (const [i, id] of ids.entries()) {
        expect(hook(workflowStartInput(id, transcript)).exitCode).toBe(0)
        writeFileSync(join(runDir, `agent-${id}.meta.json`), workflowMeta(`check:${i + 1}`))
        writeFileSync(join(runDir, `agent-${id}.jsonl`), toolCall(Date.now(), 'Work', 100) + '\n')
      }

      let clock = Date.now()
      const sent: string[] = []
      const stream = createAgentStream({
        readEvents: createEventReader([file], false),
        chat: () => '1001',
        send: async (_c, text) => { sent.push(text); return 7 },
        edit: async (_c, _id, text) => { sent.push(text) },
        now: () => clock,
      })
      stream.tick()
      await new Promise(r => setTimeout(r, 0))
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatch(new RegExp('^🤖 Subagents'
        + ids.map((_, i) => `\\n${i + 1}\\. ⏳ workflow-subagent · check:${i + 1} · Work · \\d+s · 100 tokens`).join('') + '$'))

      const before = readFileSync(file, 'utf8')
      expect(hook({ ...workflowHooks.task_stop_workflow, transcript_path: transcript }).exitCode).toBe(0)
      expect(readFileSync(file, 'utf8')).toBe(before)

      for (const [i, id] of ids.entries()) appendFileSync(join(runDir, `agent-${id}.jsonl`), interrupted(Date.now(), i === 1) + '\n')
      clock = Date.now() + CHAT_GAP_MS
      stream.tick()
      await new Promise(r => setTimeout(r, 0))
      expect(sent).toHaveLength(2)
      expect(sent[1]).toMatch(new RegExp('^🤖 Subagents'
        + ids.map((_, i) => `\\n${i + 1}\\. ⏹ Stopped after \\d+s · workflow-subagent · check:${i + 1} · 100 tokens`).join('') + '$'))
      expect(stream.agents()).toEqual([])
    } finally {
      rmSync(state, { recursive: true, force: true })
      rmSync(projects, { recursive: true, force: true })
    }
  })

  // The registered hooks with the inputs Claude Code sent for a subagent whose
  // model call failed, the subagent's files in Claude Code's own layout, and the
  // stream's own file readers: an Agent call's subagent and a workflow's.
  for (const kind of ['an Agent call', 'a workflow'] as const) {
    test(`a subagent of ${kind} that fails on an API error closes as failed on the next tick through the registered hooks`, async () => {
      const state = mkdtempSync(join(tmpdir(), 'agents-'))
      const projects = mkdtempSync(join(tmpdir(), 'projects-'))
      try {
        const [startInput, failure] = kind === 'a workflow'
          ? [failureHooks.workflow_subagent_start, failureHooks.workflow_subagent_stop_failure]
          : [failureHooks.subagent_start, failureHooks.subagent_stop_failure]
        const transcript = join(projects, `${startInput.session_id}.jsonl`)
        const folder = kind === 'a workflow'
          ? join(projects, startInput.session_id, 'subagents', 'workflows', WORKFLOW_RUN)
          : join(projects, startInput.session_id, 'subagents')
        mkdirSync(folder, { recursive: true })
        const env = { TELEGRAM_STATE_DIR: state, CLAUDE_PID: '4242' }
        expect(runRegistered('SubagentStart', { ...startInput, transcript_path: transcript }, env)).toEqual([0])
        writeFileSync(join(folder, `agent-${startInput.agent_id}.meta.json`), JSON.stringify({ agentType: 'failing-probe', description: 'Say hello' }))
        writeFileSync(join(folder, `agent-${startInput.agent_id}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: 'Say hello.' } }) + '\n')

        let clock = Date.now()
        const sent: string[] = []
        const stream = createAgentStream({
          readEvents: createEventReader([agentEventFile(state, 4242)], false),
          chat: () => '1001',
          send: async (_c, text) => { sent.push(text); return 7 },
          edit: async (_c, _id, text) => { sent.push(text) },
          now: () => clock,
        })
        stream.tick()
        await new Promise(r => setTimeout(r, 0))
        expect(sent).toEqual(['🤖 Subagents\n1. ⏳ failing-probe · Say hello · Starting… · 0s'])

        expect(runRegistered('StopFailure', { ...failure, transcript_path: transcript }, env)).toEqual([0, 0])
        // The session's turn goes on: no turn end is written.
        expect(existsSync(join(state, 'turns'))).toBe(false)
        clock += CHAT_GAP_MS
        stream.tick()
        await new Promise(r => setTimeout(r, 0))
        expect(sent).toHaveLength(2)
        expect(sent[1]).toMatch(/^🤖 Subagents\n1\. ❌ Failed after \d+s \(model_not_found\) · failing-probe · Say hello$/)
        expect(stream.agents()).toEqual([])
      } finally {
        rmSync(state, { recursive: true, force: true })
        rmSync(projects, { recursive: true, force: true })
      }
    })
  }
})
