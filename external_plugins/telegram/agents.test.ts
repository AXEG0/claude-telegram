import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AGENT_STALE_MS,
  AGENT_TICK_MS,
  CHAT_GAP_MS,
  CLOCK_REFRESH_MS,
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
    expect(eventFromHook({
      hook_event_name: 'SubagentStart',
      agent_id: 'n2',
      transcript_path: '/h/p/sess-1/subagents/agent-parent.jsonl',
    })?.agent_base).toBe('/h/p/sess-1/subagents/agent-n2')
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
    const events: AgentEvent[] = []
    const files = new Map<string, string>()
    const mtimes = new Map<string, number>()
    const sent: { chat: string; text: string }[] = []
    const edits: { id: number; text: string }[] = []
    let failEdit: unknown
    let current = chat
    const stream = createAgentStream({
      readEvents: () => events.splice(0),
      chat: () => current ?? undefined,
      send: async (c, text) => { sent.push({ chat: c, text }); return 7 },
      edit: async (_c, id, text) => {
        if (failEdit) throw failEdit
        edits.push({ id, text })
      },
      readFile: p => files.get(p),
      mtime: p => mtimes.get(p),
      now: () => t,
    })
    const settle = () => new Promise(r => setTimeout(r, 0))
    const tick = async () => { stream.tick(); await settle() }
    const write = (path: string, text: string) => { files.set(path, text); mtimes.set(path, t) }
    return {
      stream, events, sent, edits, tick, write,
      advance: (ms: number) => { t += ms },
      now: () => t,
      setChat: (c: string | null) => { current = c },
      failEditWith: (e: unknown) => { failEdit = e },
    }
  }
  const start = (h: { now(): number }, id = 'a1', extra: Partial<AgentEvent> = {}): AgentEvent =>
    ({ t: h.now(), event: 'start', agent_id: id, agent_type: 'general-purpose', agent_base: `/s/agent-${id}`, ...extra })

  test('one message per subagent, edited as it works, finished on stop', async () => {
    const h = harness()
    await h.tick() // the backlog read
    h.write('/s/agent-a1.meta.json', JSON.stringify({ description: 'Review PRs 3 and 4', agentType: 'general-purpose' }))
    h.events.push(start(h))
    await h.tick()
    expect(h.sent).toEqual([{ chat: '42', text: '🤖 general-purpose · Review PRs 3 and 4\n⏳ Starting… · 0s' }])

    h.advance(CHAT_GAP_MS)
    h.write('/s/agent-a1.jsonl', assistant([{ type: 'tool_use', name: 'Bash', input: { description: 'Checking gate mention' } }],
      { input_tokens: 85400 }, new Date(h.now()).toISOString()))
    await h.tick()
    expect(h.edits).toEqual([{ id: 7, text: '🤖 general-purpose · Review PRs 3 and 4\n⏳ Checking gate mention · 3s · 85.4k tokens' }])

    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a1' })
    await h.tick()
    expect(h.edits.at(-1)).toEqual({ id: 7, text: '🤖 general-purpose · Review PRs 3 and 4\n✅ Done in 6s · 85.4k tokens' })
    await h.tick()
    expect(h.stream.agents()).toEqual([])
  })

  test('with nothing new, only the clock moves, and only every 30 seconds', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h))
    await h.tick()
    for (let i = 0; i < 9; i++) { h.advance(AGENT_TICK_MS); await h.tick() }
    expect(h.edits).toEqual([])
    h.advance(CLOCK_REFRESH_MS); await h.tick()
    expect(h.edits.length).toBe(1)
  })

  test('all subagents in a chat share one budget', async () => {
    const h = harness()
    await h.tick()
    for (const id of ['a1', 'a2', 'a3']) h.events.push(start(h, id))
    await h.tick()
    expect(h.sent.length).toBe(1)
    h.advance(CHAT_GAP_MS); await h.tick()
    expect(h.sent.length).toBe(2)
  })

  test('a rate limit holds the chat for retry_after', async () => {
    const h = harness()
    await h.tick()
    h.events.push(start(h))
    await h.tick()
    h.failEditWith({ description: 'Too Many Requests', parameters: { retry_after: 20 } })
    h.advance(CLOCK_REFRESH_MS); await h.tick()
    h.failEditWith(undefined)
    h.advance(CLOCK_REFRESH_MS - 15_000); await h.tick()
    expect(h.edits).toEqual([])
    h.advance(10_000); await h.tick()
    expect(h.edits.length).toBe(1)
  })

  test('"message is not modified" counts as sent; a deleted message ends the stream for it', async () => {
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

  test('the backlog keeps only subagents still running', async () => {
    const h = harness()
    h.events.push(start(h, 'finished'), { t: h.now(), event: 'stop', agent_id: 'finished' }, start(h, 'running'))
    await h.tick()
    expect(h.stream.agents().map(a => a.id)).toEqual(['running'])
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
