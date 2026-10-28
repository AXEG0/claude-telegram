import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ancestorPids, BUSY_EVENTS, busyFiles, CAP_MS, createTyping, hookInput, markerFiles, PROMPT_GRACE_MS, readBusyAt, readTurnEnd, subagentFiles, TURN_END_EVENTS, writeTurnEnd } from './typing.ts'
import failureHooks from './fixtures/failure-hooks.json'
import turnHooks from './fixtures/turn-hooks.json'
import { runRegistered } from './fixtures/hooks.ts'

function harness(capMs = 60_000, chat?: string) {
  let t = 1_000
  let ended = 0
  let busy = 0
  let sub = 0
  const sent: string[] = []
  const capped: string[] = []
  const recovered: string[] = []
  const typing = createTyping({
    send: id => sent.push(id),
    turnEndedAt: () => ended,
    now: () => t,
    capMs,
    onCap: id => capped.push(id),
    onRecover: id => recovered.push(id),
    busyAt: () => busy,
    chat: () => chat,
    subagentAt: () => sub,
  })
  return {
    typing,
    sent,
    capped,
    recovered,
    advance(ms: number) { t += ms },
    endTurn() { ended = t },
    work() { busy = t },
    subagent() { sub = t },
  }
}

describe('createTyping', () => {
  test('types at once and on every tick until the turn ends', () => {
    const h = harness()
    h.typing.start('42')
    h.advance(4000); h.typing.tick()
    h.advance(4000); h.typing.tick()
    expect(h.sent).toEqual(['42', '42', '42'])

    h.endTurn()
    h.advance(4000); h.typing.tick()
    expect(h.sent.length).toBe(3)
    expect(h.typing.active()).toEqual([])
  })

  test('a turn that ended before the message keeps it typing', () => {
    const h = harness()
    h.endTurn()
    h.advance(10)
    h.typing.start('42')
    h.advance(4000); h.typing.tick()
    expect(h.sent).toEqual(['42', '42'])
  })

  test('stops at the cap when no turn end arrives, and says so once', () => {
    const h = harness(10_000)
    h.typing.start('42')
    h.advance(10_000); h.typing.tick()
    h.advance(4000); h.typing.tick()
    expect(h.sent).toEqual(['42'])
    expect(h.capped).toEqual(['42'])
    expect(h.typing.active()).toEqual([])
  })

  test('the default cap is 10 minutes', () => {
    expect(CAP_MS).toBe(10 * 60 * 1000)
  })

  test('activity after the stuck notice reports Claude back once', () => {
    const h = harness(10_000)
    h.typing.start('42')
    h.advance(10_000); h.typing.tick()
    expect(h.capped).toEqual(['42'])
    h.advance(4000); h.typing.tick()
    expect(h.recovered).toEqual([])
    h.work()
    h.advance(4000); h.typing.tick()
    h.advance(4000); h.typing.tick()
    expect(h.recovered).toEqual(['42'])
  })

  test('a turn end after the stuck notice reports Claude back, a subagent\'s call too', () => {
    const a = harness(10_000)
    a.typing.start('42')
    a.advance(10_000); a.typing.tick()
    a.advance(1); a.endTurn()
    a.advance(4000); a.typing.tick()
    expect(a.recovered).toEqual(['42'])

    const b = harness(10_000)
    b.typing.start('7')
    b.advance(10_000); b.typing.tick()
    b.advance(1); b.subagent()
    b.advance(4000); b.typing.tick()
    expect(b.recovered).toEqual(['7'])
  })

  test('a new message after the stuck notice is not Claude coming back', () => {
    const h = harness(10_000)
    h.typing.start('42')
    h.advance(10_000); h.typing.tick()
    h.advance(1000); h.typing.start('42')
    h.advance(4000); h.typing.tick()
    expect(h.recovered).toEqual([])
  })

  test('no stuck notice, no recovery message', () => {
    const h = harness(10_000)
    h.typing.start('42')
    h.advance(4000); h.work()
    h.advance(4000); h.typing.tick()
    h.endTurn()
    h.advance(4000); h.typing.tick()
    expect(h.capped).toEqual([])
    expect(h.recovered).toEqual([])
  })

  test('a turn that ends sends no stuck notice', () => {
    const h = harness(10_000)
    h.typing.start('42')
    h.advance(9_000); h.endTurn()
    h.advance(2_000); h.typing.tick()
    expect(h.capped).toEqual([])
  })

  test('a pause holds typing but keeps the chat, and resume brings it back', () => {
    const h = harness()
    h.typing.start('42')
    h.typing.pause()
    h.advance(4000); h.typing.tick()
    expect(h.sent).toEqual(['42'])
    expect(h.typing.active()).toEqual(['42'])

    h.typing.resume()
    h.advance(4000); h.typing.tick()
    expect(h.sent).toEqual(['42', '42'])
  })

  test('a pause ends with the turn, so the next message types', () => {
    const h = harness()
    h.typing.start('42')
    h.typing.pause()
    h.endTurn()
    h.advance(1); h.typing.tick()
    h.typing.start('42')
    expect(h.sent).toEqual(['42', '42'])
  })

  test('time paused on a permission prompt does not count toward the cap', () => {
    const h = harness(10_000)
    h.typing.start('42')
    h.advance(5_000)
    h.typing.pause()
    h.advance(60_000); h.typing.tick()
    expect(h.capped).toEqual([])
    h.typing.resume()
    h.advance(4_000); h.typing.tick()
    expect(h.capped).toEqual([])
    expect(h.sent).toEqual(['42', '42'])
    h.advance(2_000); h.typing.tick()
    expect(h.capped).toEqual(['42'])
  })

  test('Claude working again after a prompt answered in the terminal brings typing back', () => {
    const h = harness()
    h.typing.start('42')
    h.advance(1000)
    h.typing.pause()
    // The hook of the call that raised the prompt.
    h.advance(PROMPT_GRACE_MS - 1000); h.work()
    h.advance(3000); h.typing.tick()
    expect(h.sent).toEqual(['42'])

    h.advance(4000); h.work(); h.typing.tick()
    expect(h.sent).toEqual(['42', '42'])
    h.advance(4000); h.typing.tick()
    expect(h.sent).toEqual(['42', '42', '42'])
  })

  test('activity at the end of the grace still counts as the prompt\'s own', () => {
    const h = harness()
    h.typing.start('42')
    h.typing.pause()
    h.advance(PROMPT_GRACE_MS); h.work()
    h.advance(1); h.typing.tick()
    expect(h.sent).toEqual(['42'])
  })

  test('after a terminal answer, the cap counts from the activity that showed it', () => {
    const h = harness(10_000)
    h.typing.start('42')
    h.typing.pause()
    h.advance(60_000); h.typing.tick()
    h.work()
    h.advance(1000); h.typing.tick()
    expect(h.sent).toEqual(['42', '42'])
    h.advance(8000); h.typing.tick()
    expect(h.capped).toEqual([])
    h.advance(1500); h.typing.tick()
    expect(h.capped).toEqual(['42'])
  })

  test('a turn that ends between ticks after a terminal answer clears the chat', () => {
    const h = harness()
    h.typing.start('42')
    h.advance(1000)
    h.typing.pause()
    // The hook of the call that raised the prompt.
    h.advance(30); h.work()
    for (let i = 0; i < 14; i++) { h.advance(4000); h.typing.tick() }
    h.advance(1970); h.typing.tick()
    h.advance(1000); h.work()
    h.advance(1000); h.endTurn()
    h.advance(500); h.typing.tick()
    expect(h.typing.active()).toEqual([])
    expect(h.sent).toEqual(['42'])
  })

  test('a second prompt before the next tick holds typing while it waits', () => {
    const h = harness(60_000)
    h.typing.start('42')
    h.typing.pause()
    // Answered in the terminal; the next call raises another prompt.
    h.advance(30_000); h.work()
    h.typing.pause()
    h.advance(100); h.work()
    for (let i = 0; i < 50; i++) { h.advance(4000); h.typing.tick() }
    expect(h.sent).toEqual(['42'])
    expect(h.capped).toEqual([])
  })

  test('the grace covers the busy hook\'s timeout', () => {
    const hooks = JSON.parse(readFileSync(join(import.meta.dir, 'hooks', 'hooks.json'), 'utf8'))
    const timeout = hooks.hooks.PreToolUse[0].hooks[0].timeout
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toContain('busy.ts')
    expect(PROMPT_GRACE_MS).toBeGreaterThanOrEqual(timeout * 1000)
  })

  test('a subagent working while Claude\'s prompt waits keeps typing paused', () => {
    const h = harness(60_000)
    h.typing.start('42')
    h.typing.pause()
    for (let i = 0; i < 50; i++) { h.advance(4000); h.subagent(); h.typing.tick() }
    expect(h.sent).toEqual(['42'])
    expect(h.capped).toEqual([])
  })

  test('a pause with no chat typing does not hold the next message', () => {
    const h = harness()
    h.typing.pause()
    h.typing.start('42')
    h.advance(4000); h.typing.tick()
    expect(h.sent).toEqual(['42', '42'])
  })
})

describe('typing for a turn no message started', () => {
  test('types into the last chat while the session is busy, until the turn ends', () => {
    const h = harness(60_000, '42')
    h.work()
    h.advance(100); h.typing.tick()
    h.advance(4000); h.work(); h.typing.tick()
    expect(h.sent).toEqual(['42', '42'])
    h.advance(1000); h.endTurn()
    h.advance(4000); h.typing.tick()
    expect(h.sent.length).toBe(2)
    expect(h.typing.active()).toEqual([])
  })

  test('activity from before the last turn end starts nothing', () => {
    const h = harness(60_000, '42')
    h.work(); h.advance(10); h.endTurn()
    h.advance(4000); h.typing.tick()
    expect(h.sent).toEqual([])
  })

  test('the cap counts from the last activity', () => {
    const h = harness(10_000, '42')
    h.work(); h.typing.tick()
    for (let i = 0; i < 5; i++) { h.advance(4000); h.work(); h.typing.tick() }
    expect(h.capped).toEqual([])
    h.advance(10_000); h.typing.tick()
    expect(h.capped).toEqual(['42'])
  })

  test('nothing without a chat', () => {
    const h = harness(60_000)
    h.work(); h.advance(10); h.typing.tick()
    expect(h.sent).toEqual([])
  })
})

describe('a subagent\'s tool calls', () => {
  test('keep the turn\'s typing clear of the cap', () => {
    const h = harness(10_000)
    h.typing.start('42')
    for (let i = 0; i < 5; i++) { h.advance(4000); h.subagent(); h.typing.tick() }
    expect(h.capped).toEqual([])
    expect(h.sent.length).toBe(6)
    h.advance(10_000); h.typing.tick()
    expect(h.capped).toEqual(['42'])
  })

  test('during a permission prompt they hold nothing past the turn\'s end', () => {
    const h = harness(30 * 60_000)
    h.typing.start('42')
    h.advance(5_000)
    h.typing.pause()
    for (let i = 0; i < 150; i++) { h.advance(4000); h.subagent(); h.typing.tick() }
    h.typing.resume()
    h.advance(90_000); h.endTurn()
    h.advance(4000); h.typing.tick()
    expect(h.typing.active()).toEqual([])
    expect(h.capped).toEqual([])
  })

  test('start nothing, and bring back no turn that has ended', () => {
    const h = harness(60_000, '42')
    h.subagent(); h.advance(100); h.typing.tick()
    expect(h.sent).toEqual([])

    h.typing.start('42')
    h.advance(1000); h.endTurn()
    h.advance(1000); h.subagent()
    h.advance(1000); h.typing.tick()
    h.advance(4000); h.subagent(); h.typing.tick()
    expect(h.sent).toEqual(['42'])
    expect(h.typing.active()).toEqual([])
  })
})

describe('turn-end markers', () => {
  test('one file per session id and per Claude Code pid', () => {
    expect(markerFiles('/s', 'abc-123', [4242, 99])).toEqual(['/s/turns/session-abc-123', '/s/turns/pid-4242', '/s/turns/pid-99'])
    expect(markerFiles('/s', '../escape', [4242])).toEqual(['/s/turns/pid-4242'])
    expect(markerFiles('/s', undefined, [1])).toEqual([])
  })

  test('the ancestors start at the given pid and include its parent', () => {
    const pids = ancestorPids(process.pid)
    expect(pids[0]).toBe(process.pid)
    expect(pids[1]).toBe(process.ppid)
  })

  test('the latest end across the files is the turn end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typing-'))
    const [a, b] = markerFiles(dir, 'sess', [4242])
    expect(readTurnEnd([a!, b!])).toBe(0)
    writeTurnEnd([a!], 5)
    writeTurnEnd([b!], 9)
    expect(readTurnEnd([a!, b!])).toBe(9)
  })
})

describe('hooks/busy.ts', () => {
  const run = (stdin: string, env: Record<string, string>) => Bun.spawnSync(['bun', join(import.meta.dir, 'hooks', 'busy.ts')], {
    stdin: new TextEncoder().encode(stdin),
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env },
  })

  test('touches busy-<Claude Code pid> for Claude\'s own call, whatever its tool input holds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typing-'))
    const input = JSON.stringify({ ...turnHooks.pre_tool_use, tool_name: 'mcp__a2a__send', tool_input: { agent_id: 'peer' } })
    expect(run(input, { TELEGRAM_STATE_DIR: dir, CLAUDE_PID: '4242' }).exitCode).toBe(0)
    expect(readBusyAt(busyFiles(dir, [4242]))).toBeGreaterThan(0)
    expect(readBusyAt(subagentFiles(dir, [4242]))).toBe(0)
  })

  test('a subagent\'s call touches subagent-<pid> instead', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typing-'))
    const input = JSON.stringify(turnHooks.subagent_pre_tool_use)
    expect(run(input, { TELEGRAM_STATE_DIR: dir, CLAUDE_PID: '4242' }).exitCode).toBe(0)
    expect(readdirSync(join(dir, 'turns'))).toEqual(['subagent-4242'])
  })

  test('runs at every tool call\'s start and end, failed ones included, and at every prompt', () => {
    const hooks = JSON.parse(readFileSync(join(import.meta.dir, 'hooks', 'hooks.json'), 'utf8')).hooks
    const busy = 'bun "${CLAUDE_PLUGIN_ROOT}/hooks/busy.ts"'
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit']) {
      const entries = hooks[event].filter((h: { matcher?: string; hooks: { command: string }[] }) =>
        !h.matcher && h.hooks.some(x => x.command === busy))
      expect(entries).toHaveLength(1)
    }
  })

})

describe('hooks/turn-end.ts', () => {
  function runHook(stdin: string, env: Record<string, string>) {
    return Bun.spawnSync(['bun', join(import.meta.dir, 'hooks', 'turn-end.ts')], {
      stdin: new TextEncoder().encode(stdin),
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env },
    })
  }

  test('writes the end time for the session id and the pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typing-'))
    const before = Date.now()
    const r = runHook(JSON.stringify({ session_id: 'sess-1', hook_event_name: 'Stop' }), {
      TELEGRAM_STATE_DIR: dir,
      CLAUDE_PID: '4242',
    })
    expect(r.exitCode).toBe(0)
    expect(readdirSync(join(dir, 'turns')).sort()).toEqual(['pid-4242', 'session-sess-1'])
    expect(Number(readFileSync(join(dir, 'turns', 'session-sess-1'), 'utf8'))).toBeGreaterThanOrEqual(before)
  })

  test('a subagent\'s StopFailure writes no turn end; the main session\'s StopFailure still does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typing-'))
    const env = { TELEGRAM_STATE_DIR: dir, CLAUDE_PID: '4242' }
    expect(runHook(JSON.stringify(failureHooks.subagent_stop_failure), env).exitCode).toBe(0)
    expect(existsSync(join(dir, 'turns'))).toBe(false)
    const before = Date.now()
    expect(runHook(JSON.stringify(failureHooks.main_stop_failure), env).exitCode).toBe(0)
    expect(readdirSync(join(dir, 'turns')).sort()).toEqual(['pid-4242', `session-${failureHooks.main_stop_failure.session_id}`])
    expect(Number(readFileSync(join(dir, 'turns', 'pid-4242'), 'utf8'))).toBeGreaterThanOrEqual(before)
    // Only a StopFailure that names a subagent is skipped.
    const other = mkdtempSync(join(tmpdir(), 'typing-'))
    const { agent_id, session_id } = failureHooks.subagent_stop_failure
    expect(runHook(JSON.stringify({ session_id, agent_id, hook_event_name: 'Stop' }), { TELEGRAM_STATE_DIR: other, CLAUDE_PID: '4242' }).exitCode).toBe(0)
    expect(readdirSync(join(other, 'turns')).sort()).toEqual(['pid-4242', `session-${session_id}`])
  })

})

// Any shell started inside a Claude Code session inherits its CLAUDE_PID, so
// a marking hook run there by hand would mark that session's turn. Each one
// acts only on a JSON object that names one of its own events exactly and
// carries a non-empty text session_id (see hookInput); an object of that shape
// built by hand still marks, as a real hook would.
describe('the marking hooks act only on hook input', () => {
  const hooksJson = JSON.parse(readFileSync(join(import.meta.dir, 'hooks', 'hooks.json'), 'utf8')).hooks
  // The input Claude Code sends for each event these hooks run on, and for
  // the two subagent events, which neither runs on.
  const recorded: Record<string, { session_id: string; hook_event_name: string }> = {
    UserPromptSubmit: turnHooks.user_prompt_submit,
    PreToolUse: turnHooks.pre_tool_use,
    PostToolUse: turnHooks.post_tool_use,
    PostToolUseFailure: turnHooks.post_tool_use_failure,
    Stop: turnHooks.stop,
    StopFailure: turnHooks.stop_failure,
    SessionEnd: turnHooks.session_end,
    SubagentStart: turnHooks.subagent_start,
    SubagentStop: turnHooks.subagent_stop,
  }
  const scripts: [string, readonly string[]][] = [['busy.ts', BUSY_EVENTS], ['turn-end.ts', TURN_END_EVENTS]]
  const run = (script: string, stdin: string, dir: string) => Bun.spawnSync(['bun', join(import.meta.dir, 'hooks', script)], {
    stdin: new TextEncoder().encode(stdin),
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, TELEGRAM_STATE_DIR: dir, CLAUDE_PID: '4242' },
  })

  // Every file under dir, with its content and mtime.
  function snapshot(dir: string, prefix = ''): Record<string, [string, number]> {
    const out: Record<string, [string, number]> = {}
    for (const name of readdirSync(join(dir, prefix))) {
      const rel = join(prefix, name)
      const st = statSync(join(dir, rel))
      if (st.isDirectory()) Object.assign(out, snapshot(dir, rel))
      else out[rel] = [readFileSync(join(dir, rel), 'utf8'), st.mtimeMs]
    }
    return out
  }

  // A state folder holding this session's marks from an hour ago, and a mark
  // older than a week, which the turn-end hook's sweep deletes.
  function seeded(): string {
    const dir = mkdtempSync(join(tmpdir(), 'typing-'))
    const turns = join(dir, 'turns')
    mkdirSync(turns)
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
    for (const name of ['pid-4242', 'busy-4242', 'subagent-4242', `session-${turnHooks.stop.session_id}`]) {
      writeFileSync(join(turns, name), name.startsWith('busy') || name.startsWith('subagent') ? '' : '5')
      utimesSync(join(turns, name), hourAgo, hourAgo)
    }
    const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    writeFileSync(join(turns, 'pid-77'), '5')
    utimesSync(join(turns, 'pid-77'), weekAgo, weekAgo)
    return dir
  }

  test('each hook\'s events are the events hooks.json runs it on', () => {
    for (const [script, events] of scripts) {
      const command = `bun "\${CLAUDE_PLUGIN_ROOT}/hooks/${script}"`
      const on = Object.keys(hooksJson).filter(event =>
        hooksJson[event].some((g: { hooks: { command: string }[] }) => g.hooks.some(h => h.command === command)))
      expect(on.sort()).toEqual([...events].sort())
    }
  })

  test('the recorded input of each event passes for the hook that runs on it, and for no other', () => {
    for (const [, events] of scripts) {
      for (const [event, input] of Object.entries(recorded)) {
        expect(hookInput(JSON.stringify(input), events) !== undefined).toBe(events.includes(event))
      }
    }
  })

  // The event, case and session rows, built for each of the hook's own events
  // from its recorded input.
  function ownEventRows(event: string): [string, string][] {
    const own = recorded[event]!
    const { session_id: _, ...withoutSession } = own
    return [
      [`its own event ${event} in lower case`, JSON.stringify({ ...own, hook_event_name: event.toLowerCase() })],
      [`its own event ${event} with a trailing space`, JSON.stringify({ ...own, hook_event_name: `${event} ` })],
      [`its own event ${event} without the session`, JSON.stringify(withoutSession)],
      [`its own event ${event} from a subagent, without the session`, JSON.stringify({ ...withoutSession, agent_id: turnHooks.subagent_pre_tool_use.agent_id })],
      [`its own event ${event} with an empty session`, JSON.stringify({ ...own, session_id: '' })],
      [`its own event ${event} with a session that is not text`, JSON.stringify({ ...own, session_id: 5 })],
      [`its own event ${event} with a session that is true`, JSON.stringify({ ...own, session_id: true })],
      [`its own event ${event} with a session that is an object`, JSON.stringify({ ...own, session_id: { a: 1 } })],
    ]
  }

  for (const [script, events] of scripts) {
    const own = recorded[events[0]!]!
    const notHookInput: [string, string][] = [
      ['nothing', ''],
      ['text', 'not json'],
      ['a number', '17'],
      ['a string', '"x"'],
      ['true', 'true'],
      ['null', 'null'],
      ['an empty array', '[]'],
      ['an array holding its hook input', JSON.stringify([own])],
      ['an empty object', '{}'],
      ['an object with a session and no event', JSON.stringify({ session_id: own.session_id })],
      ['an event no marking hook runs on', JSON.stringify({ ...turnHooks.session_end, hook_event_name: 'SessionStart', source: 'startup' })],
      ...events.flatMap(ownEventRows),
      ...Object.entries(recorded).filter(([event]) => !events.includes(event))
        .map(([event, input]): [string, string] => [`the ${event} input, an event it does not run on`, JSON.stringify(input)]),
    ]

    describe(`hooks/${script}, run with CLAUDE_PID set`, () => {
      test.each(notHookInput)('leaves the state folder as it was, given %s', (_, stdin) => {
        const dir = seeded()
        const before = snapshot(dir)
        expect(run(script, stdin, dir).exitCode).toBe(0)
        expect(snapshot(dir)).toEqual(before)
      })

      test.each(notHookInput)('creates no state folder, given %s', (_, stdin) => {
        const dir = join(mkdtempSync(join(tmpdir(), 'typing-')), 'state')
        expect(run(script, stdin, dir).exitCode).toBe(0)
        expect(existsSync(dir)).toBe(false)
      })

      test.each(events.map(e => [e]))('marks the session on its recorded %s input, run as hooks.json runs it', event => {
        const dir = mkdtempSync(join(tmpdir(), 'typing-'))
        const before = Date.now()
        // StopFailure also runs hooks/subagent.ts, which records nothing for the main session's.
        expect(new Set(runRegistered(event, recorded[event]!, { TELEGRAM_STATE_DIR: dir, CLAUDE_PID: '4242' }))).toEqual(new Set([0]))
        const turns = join(dir, 'turns')
        if (script === 'busy.ts') {
          expect(readdirSync(turns)).toEqual(['busy-4242'])
        } else {
          expect(readdirSync(turns).sort()).toEqual(['pid-4242', `session-${recorded[event]!.session_id}`])
          expect(readTurnEnd([join(turns, 'pid-4242')])).toBeGreaterThanOrEqual(before)
        }
      })

      // Built from Claude Code's input builder, not recorded: a served call's
      // session is `served:<caller>` with an empty transcript path, and a hook
      // run on another machine gets every path-like field emptied.
      const forms: [string, (input: { session_id: string }) => { session_id: string }][] = [
        ['a served call', input => ({ ...input, session_id: 'served:unknown', transcript_path: '' })],
        ['another machine', input => ({ ...input, transcript_path: '', cwd: '' })],
      ]
      test.each(events.flatMap(event => forms.map(([form, make]) => [event, form, make] as const)))(
        'marks the session on its %s input as %s sends it', (event, _, make) => {
          const dir = mkdtempSync(join(tmpdir(), 'typing-'))
          const input = make(recorded[event]!)
          expect(new Set(runRegistered(event, input, { TELEGRAM_STATE_DIR: dir, CLAUDE_PID: '4242' }))).toEqual(new Set([0]))
          const turns = join(dir, 'turns')
          if (script === 'busy.ts') expect(readdirSync(turns)).toEqual(['busy-4242'])
          // A served call's session id is no file name, so only the pid marks its turn, as on main.
          else expect(readdirSync(turns).sort()).toEqual(/^[\w-]+$/.test(input.session_id) ? ['pid-4242', `session-${input.session_id}`] : ['pid-4242'])
        })
    })
  }

  test.each([['PreToolUse', turnHooks.subagent_pre_tool_use], ['PostToolUse', turnHooks.subagent_post_tool_use]] as const)(
    'a subagent\'s recorded %s input marks it working on', (event, input) => {
      const dir = mkdtempSync(join(tmpdir(), 'typing-'))
      expect(runRegistered(event, input, { TELEGRAM_STATE_DIR: dir, CLAUDE_PID: '4242' })).toEqual([0])
      expect(readdirSync(join(dir, 'turns'))).toEqual(['subagent-4242'])
    })
})
