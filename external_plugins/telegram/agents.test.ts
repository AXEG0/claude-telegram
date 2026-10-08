import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AGENT_EDIT_MS,
  AGENT_STALE_MS,
  agentEventFile,
  createAgentStream,
  createEventReader,
  eventFromHook,
  formatDuration,
  formatTokens,
  progressFromTranscript,
  type AgentEvent,
} from './agents.ts'

const assistant = (content: unknown[], usage?: Record<string, number>, ts = '2026-10-08T15:00:00.000Z') =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { content, usage } })

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
    expect(eventFromHook({ hook_event_name: 'Stop', agent_id: 'x1' })).toBeUndefined()
    expect(eventFromHook({ hook_event_name: 'SubagentStart', agent_id: '../x' })).toBeUndefined()
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
})

describe('progressFromTranscript', () => {
  test('the last tool call and the last request’s context size', () => {
    const text = [
      assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b/server.ts' } }], { input_tokens: 1, output_tokens: 1 }),
      assistant([{ type: 'text', text: 'hm' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'Checking gate mention and server env' } }],
        { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 84000, output_tokens: 400 }, '2026-10-08T15:04:31.000Z'),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
    ].join('\n')
    expect(progressFromTranscript(text)).toEqual({
      step: 'Checking gate mention and server env',
      tokens: 85402,
      updatedAt: Date.parse('2026-10-08T15:04:31.000Z'),
    })
  })

  test('a tool without a description shows its tool and target', () => {
    expect(progressFromTranscript(assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b/server.ts' } }])).step)
      .toBe('Read server.ts')
    expect(progressFromTranscript(assistant([{ type: 'tool_use', name: 'Grep', input: { pattern: 'typing.start' } }])).step)
      .toBe('Grep typing.start')
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
    const events: AgentEvent[] = []
    const files = new Map<string, string>()
    const sent: { chat: string; text: string }[] = []
    const edits: { id: number; text: string }[] = []
    const stream = createAgentStream({
      readEvents: () => events.splice(0),
      chat: () => chat ?? undefined,
      send: async (c, text) => { sent.push({ chat: c, text }); return 7 },
      edit: async (_c, id, text) => { edits.push({ id, text }) },
      readFile: p => files.get(p),
      now: () => t,
    })
    const settle = () => new Promise(r => setTimeout(r, 0))
    return { stream, events, files, sent, edits, settle, advance: (ms: number) => { t += ms }, now: () => t }
  }

  test('one message per subagent, edited as it works, finished on stop', async () => {
    const h = harness()
    h.files.set('/s/agent-a1.meta.json', JSON.stringify({ description: 'Review PRs 3 and 4', agentType: 'general-purpose' }))
    h.events.push({ t: h.now(), event: 'start', agent_id: 'a1', agent_type: 'general-purpose', agent_base: '/s/agent-a1' })
    h.stream.tick(); await h.settle()
    expect(h.sent).toEqual([{ chat: '42', text: '🤖 general-purpose · Review PRs 3 and 4\n⏳ Starting… · 0s' }])

    h.files.set('/s/agent-a1.jsonl', assistant([{ type: 'tool_use', name: 'Bash', input: { description: 'Checking gate mention' } }],
      { input_tokens: 85400 }, new Date(h.now()).toISOString()))
    h.advance(AGENT_EDIT_MS)
    h.stream.tick(); await h.settle()
    expect(h.edits).toEqual([{ id: 7, text: '🤖 general-purpose · Review PRs 3 and 4\n⏳ Checking gate mention · 5s · 85.4k tokens' }])

    h.advance(1000)
    h.stream.tick(); await h.settle()
    expect(h.edits.length).toBe(1)

    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a1' })
    h.stream.tick(); await h.settle()
    expect(h.edits.at(-1)).toEqual({ id: 7, text: '🤖 general-purpose · Review PRs 3 and 4\n✅ Done in 6s · 85.4k tokens' })
    h.stream.tick(); await h.settle()
    expect(h.stream.agents()).toEqual([])
  })

  test('nothing streams without a private chat to stream into', async () => {
    const h = harness(null)
    h.events.push({ t: h.now(), event: 'start', agent_id: 'a1', agent_type: 'Explore' })
    h.stream.tick(); await h.settle()
    expect(h.sent).toEqual([])
    expect(h.stream.agents()).toEqual([])
  })

  test('a subagent whose stop never comes is closed once its transcript goes quiet', async () => {
    const h = harness()
    h.events.push({ t: h.now(), event: 'start', agent_id: 'a1', agent_type: 'Explore' })
    h.stream.tick(); await h.settle()
    h.advance(AGENT_STALE_MS + 1)
    h.stream.tick(); await h.settle()
    expect(h.edits.at(-1)?.text).toContain('✅ Done in')
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
})
