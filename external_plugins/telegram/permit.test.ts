import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import hooksConfig from './hooks/hooks.json'
import {
  ALLOW_OUTPUT, appendPermit, createPermitReader, permitDetail, permitFile, permitFromHook, permitText,
  PERMIT_MESSAGE_LIMIT, type PermitEvent,
} from './permit.ts'
import { CHANNEL_ENTRY } from './polling.ts'

const dirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-permit-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ask = {
  hook_event_name: 'PermissionRequest',
  permission_mode: 'bypassPermissions',
  tool_name: 'Bash',
  tool_input: { command: 'cd /w && python3 c exec h -- bash -lc "ls"', description: 'Push job archive to rental' },
}

describe('permitFromHook', () => {
  test('allows a Bash ask in a bypass-mode channel session, carrying what the notice shows', () => {
    expect(permitFromHook({ ...ask, agent_type: 'general-purpose' }, true, 5)).toEqual({
      t: 5, event: 'allowed', tool_name: 'Bash',
      description: 'Push job archive to rental',
      command: 'cd /w && python3 c exec h -- bash -lc "ls"',
      agent_type: 'general-purpose',
    })
    expect(permitFromHook(ask, true, 5)).toEqual({
      t: 5, event: 'allowed', tool_name: 'Bash', description: 'Push job archive to rental', command: ask.tool_input.command,
    })
  })

  test('leaves the ask as it is outside the channel session', () => {
    expect(permitFromHook(ask, false)).toBeUndefined()
  })

  test('leaves the ask as it is in every other mode', () => {
    for (const permission_mode of ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', undefined, 'BypassPermissions']) {
      expect(permitFromHook({ ...ask, permission_mode }, true)).toBeUndefined()
    }
  })

  test('leaves the ask as it is for every other tool and event', () => {
    for (const tool_name of ['Write', 'Edit', 'AskUserQuestion', 'mcp__plugin_telegram_telegram__reply', undefined]) {
      expect(permitFromHook({ ...ask, tool_name }, true)).toBeUndefined()
    }
    expect(permitFromHook({ ...ask, hook_event_name: 'PreToolUse' }, true)).toBeUndefined()
  })

  test('a call without a description or a command still gets its notice', () => {
    expect(permitFromHook({ ...ask, tool_input: { description: '  ' } }, true, 1)).toEqual({ t: 1, event: 'allowed', tool_name: 'Bash' })
    expect(permitFromHook({ ...ask, tool_input: 'not an object' }, true, 1)).toEqual({ t: 1, event: 'allowed', tool_name: 'Bash' })
  })
})

describe('the notice', () => {
  const ev: PermitEvent = { t: 1, event: 'allowed', tool_name: 'Bash', description: 'Push job archive to rental', command: 'ls -la' }

  test('names the tool, who asked and what the call does', () => {
    expect(permitText({ ...ev, agent_type: 'general-purpose' })).toBe('🔓 Allowed · Bash · general-purpose agent\nPush job archive to rental')
    expect(permitText(ev)).toBe('🔓 Allowed · Bash · main session\nPush job archive to rental')
    expect(permitText({ t: 1, event: 'allowed', tool_name: 'Bash' })).toBe('🔓 Allowed · Bash · main session\nRun shell command')
  })

  test('See more adds the command, cut to one message', () => {
    expect(permitDetail(ev)).toBe('🔓 Allowed · Bash · main session\nPush job archive to rental\n\nls -la')
    const long = permitDetail({ ...ev, command: 'x'.repeat(10_000) })
    expect(long.length).toBe(PERMIT_MESSAGE_LIMIT)
    expect(long.endsWith('x…')).toBe(true)
  })
})

describe('createPermitReader', () => {
  test('reads only what is appended after it starts, a whole line at a time', () => {
    const dir = tmp()
    const file = permitFile(dir, 4242)
    appendPermit(file, { t: 1, event: 'allowed', tool_name: 'Bash', description: 'before' })
    const read = createPermitReader([file, permitFile(dir, 1)])
    expect(read()).toEqual([])
    appendPermit(file, { t: 2, event: 'allowed', tool_name: 'Bash', description: 'after' })
    appendFileSync(file, 'not json\n{"t":3,"event":"start","agent_id":"a"}\n{"t":4,"event":"allowed"')
    expect(read()).toEqual([{ t: 2, event: 'allowed', tool_name: 'Bash', description: 'after' }])
    appendFileSync(file, ',"tool_name":"Bash"}\n')
    expect(read()).toEqual([{ t: 4, event: 'allowed', tool_name: 'Bash' }])
    expect(read()).toEqual([])
  })
})

// Real /proc ancestry: the hook runs as the child of a process whose argv[0]
// is claude, as under Claude Code.
describe.skipIf(process.platform !== 'linux')('hooks/permission.ts', () => {
  const hook = join(import.meta.dir, 'hooks', 'permission.ts')
  const parent = join(import.meta.dir, 'fixtures', 'claude-hook.ts')
  function run(input: unknown, opts: { channel?: boolean; state?: string } = {}) {
    const state = opts.state ?? tmp()
    const args = [parent, hook, ...(opts.channel === false ? ['-p', 'hello'] : ['--channels', CHANNEL_ENTRY])]
    const r = spawnSync(process.execPath, args, {
      argv0: 'claude',
      input: typeof input === 'string' ? input : JSON.stringify(input),
      env: { ...process.env, TELEGRAM_STATE_DIR: state, CLAUDE_PID: '' },
      encoding: 'utf8',
    })
    const permits = join(state, 'permits')
    const events = existsSync(permits)
      ? readdirSync(permits).flatMap(f => readFileSync(join(permits, f), 'utf8').trim().split('\n').map(l => JSON.parse(l)))
      : []
    return { status: r.status, stdout: r.stdout, events }
  }

  test('in a bypass-mode channel session, records the call and allows it', () => {
    const r = run({ ...ask, agent_type: 'general-purpose' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe(ALLOW_OUTPUT + '\n')
    expect(r.events).toMatchObject([{ event: 'allowed', tool_name: 'Bash', description: 'Push job archive to rental', agent_type: 'general-purpose' }])
  })

  test('outside the channel session, in another mode or for another tool, answers nothing and records nothing', () => {
    for (const r of [
      run(ask, { channel: false }),
      run({ ...ask, permission_mode: 'default' }),
      run({ ...ask, tool_name: 'Write' }),
    ]) {
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
      expect(r.events).toEqual([])
    }
  })

  test('a record it cannot write, or input it cannot read, answers nothing, so Claude Code asks', () => {
    const dir = tmp()
    const blocked = join(dir, 'state-is-a-file')
    writeFileSync(blocked, '')
    for (const r of [run(ask, { state: blocked }), run('not json')]) {
      expect(r.status).toBe(0)
      expect(r.stdout).toBe('')
    }
  })

  test('is registered for Bash asks and runs before Claude Code asks, not in the background', () => {
    const entries = (hooksConfig.hooks as Record<string, { matcher?: string; hooks: { command: string; async?: boolean }[] }[]>).PermissionRequest
    expect(entries).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bun "${CLAUDE_PLUGIN_ROOT}/hooks/permission.ts"', timeout: 10 }] } as never])
    expect(entries![0]!.hooks[0]!.async).toBeUndefined()
  })
})
