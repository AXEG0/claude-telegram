import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  AGENT_STALE_MS,
  AGENT_MESSAGE_LIMIT,
  AGENT_TICK_MS,
  CHAT_GAP_MS,
  CLOCK_REFRESH_MS,
  agentEventFile,
  createAgentStream,
  createEventReader,
  eventFromHook,
  formatDuration,
  formatTokens,
  interruptionFromTranscript,
  progressFromTranscript,
  THINKING,
  WRITING,
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
})

const interrupted = (t: number) => JSON.stringify({
  type: 'user', timestamp: new Date(t).toISOString(),
  message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
})

describe('interruptionFromTranscript', () => {
  test('reads an explicit terminal interruption, ignoring a partial line and trailing metadata', () => {
    expect(interruptionFromTranscript(interrupted(5000) + '\n' + JSON.stringify({ type: 'attachment' }) + '\n{"type":'))
      .toBe(5000)
  })
  test('ignores an interruption followed by resumed work or quoted in an answer', () => {
    expect(interruptionFromTranscript(interrupted(5000) + '\n' + assistant([{ type: 'text', text: 'Working again' }]))).toBeUndefined()
    expect(interruptionFromTranscript(interrupted(5000) + '\n' + JSON.stringify({ type: 'user', message: { content: 'Continue' } }))).toBeUndefined()
    expect(interruptionFromTranscript(assistant([{ type: 'text', text: '[Request interrupted by user]' }]))).toBeUndefined()
    expect(interruptionFromTranscript(JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }))).toBeUndefined()
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
    const events: AgentEvent[] = []
    const files = new Map<string, string>()
    const mtimes = new Map<string, number>()
    const sent: { chat: string; text: string }[] = []
    const edits: { id: number; text: string }[] = []
    let failEdit: unknown
    let sendWait: Promise<void> | undefined
    let editWait: Promise<void> | undefined
    let current = chat
    const stream = createAgentStream({
      readEvents: () => events.splice(0),
      chat: () => current ?? undefined,
      send: async (c, text) => { sent.push({ chat: c, text }); const id = sent.length + 6; await sendWait; return id },
      edit: async (_c, id, text) => {
        if (failEdit) throw failEdit
        edits.push({ id, text })
        await editWait
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
      holdSend: () => { let release!: () => void; sendWait = new Promise<void>(r => { release = r }); return () => { sendWait = undefined; release() } },
      holdEdit: () => { let release!: () => void; editWait = new Promise<void>(r => { release = r }); return () => { editWait = undefined; release() } },
    }
  }
  const start = (h: { now(): number }, id = 'a1', extra: Partial<AgentEvent> = {}): AgentEvent =>
    ({ t: h.now(), event: 'start', agent_id: id, agent_type: 'general-purpose', agent_base: `/s/agent-${id}`, ...extra })

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
    expect(h.edits).toEqual([{ id: 7, text: '🤖 Subagents\n1. ⏳ general-purpose · Review PRs 3 and 4 · Checking gate mention · 3s · 85.4k tokens' }])

    h.advance(CHAT_GAP_MS)
    h.events.push({ t: h.now(), event: 'stop', agent_id: 'a1' })
    await h.tick()
    expect(h.edits.at(-1)).toEqual({ id: 7, text: '🤖 Subagents\n1. ✅ Done in 6s · general-purpose · Review PRs 3 and 4 · 85.4k tokens' })
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
    h.advance(AGENT_TICK_MS)
    h.write('/s/agent-a1.jsonl', assistant([{ type: 'text', text: 'Working' }], { input_tokens: 32300 }) + '\n' + interrupted(h.now()))
    await h.tick()
    expect(h.edits.at(-1)).toEqual({ id: 7, text: '🤖 Subagents\n1. ⏹ Stopped after 3s · general-purpose · 32.3k tokens' })
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
    expect(h.edits.at(-1)?.text).toContain('⏹ Stopped after 3s')
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
    h.advance(CHAT_GAP_MS); await h.tick()
    expect(h.sent.length).toBe(1)
    expect(h.edits).toEqual([])
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
    expect(h.edits.at(-1)?.text).toContain('⏹ Stopped after 6s')
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
    for (let i = 0; i < 40; i++) {
      h.write('/s/agent-busy.jsonl', assistant([{ type: 'tool_use', name: 'Bash', input: { description: `Step ${i}` } }]))
      if (i === 1) h.events.push({ t: h.now(), event: 'stop', agent_id: 'second', outcome: 'stopped' })
      if (i === 2) h.events.push({ t: h.now(), event: 'stop', agent_id: 'third' })
      await h.tick()
      const text = h.edits.at(-1)!.text
      for (const label of ['Busy first agent', 'second', 'third', 'fourth']) expect(text).toContain(label)
      expect(text).toContain(`Step ${i}`)
      if (i >= 1) expect(text).toContain('2. ⏹ Stopped after')
      if (i >= 2) expect(text).toContain('3. ✅ Done in')
      h.advance(AGENT_TICK_MS)
    }
    expect(h.sent).toHaveLength(1)
    expect(new Set(h.edits.map(e => e.id))).toEqual(new Set([7]))
    expect(h.stream.agents().map(a => a.id)).toEqual(['busy', 'fourth'])
  })

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
    h.advance(CLOCK_REFRESH_MS); await h.tick()
    h.failEditWith(undefined)
    h.advance(15_000); await h.tick()
    expect(h.edits).toEqual([])
    h.advance(10_000); await h.tick()
    expect(h.edits.length).toBe(1)
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
    expect(h.sent.at(-1)?.text).toContain('⏹ Stopped after 3s')
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
})
