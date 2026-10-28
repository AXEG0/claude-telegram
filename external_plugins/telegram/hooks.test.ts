// Every hook script hooks.json registers, run by hand from a shell inside a
// Claude Code session, which inherits the session's CLAUDE_PID, with nothing,
// text, an empty array, an empty object, an input for an event no hook runs
// on, or closed stdin, writes nothing and answers nothing.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = import.meta.dir
const hooks: Record<string, { hooks: { command: string }[] }[]> =
  JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks
const commands = [...new Set(Object.values(hooks).flatMap(groups => groups.flatMap(g => g.hooks.map(h => h.command))))]

const notHookInput: [string, string][] = [
  ['nothing', ''],
  ['text', 'not json'],
  ['an empty array', '[]'],
  ['an empty object', '{}'],
  ['an event no hook runs on', JSON.stringify({ session_id: 'sess-1', hook_event_name: 'SessionStart', source: 'startup' })],
]

describe('a hook script run without hook input', () => {
  test('the sweep covers the four hook scripts, and any registered later', () => {
    expect(commands.map(c => c.match(/hooks\/([\w-]+\.ts)/)?.[1])).toEqual(expect.arrayContaining(['busy.ts', 'permission.ts', 'subagent.ts', 'turn-end.ts']))
  })

  for (const command of commands) {
    test.each(notHookInput)(`${command} writes and prints nothing, given %s`, (_, stdin) => {
      const dir = mkdtempSync(join(tmpdir(), 'hooks-'))
      const r = Bun.spawnSync(['sh', '-c', command], {
        stdin: new TextEncoder().encode(stdin),
        env: { PATH: process.env.PATH!, HOME: process.env.HOME!, CLAUDE_PLUGIN_ROOT: ROOT, TELEGRAM_STATE_DIR: dir, CLAUDE_PID: '4242' },
      })
      expect(r.exitCode).toBe(0)
      expect(r.stdout.toString()).toBe('')
      expect(readdirSync(dir)).toEqual([])
    })

    // Bun opens a closed stdin on /dev/null, so a hook reads it as empty and
    // takes the same path as given nothing; this row guards a runtime whose
    // read throws instead.
    test(`${command} writes and prints nothing with its stdin closed`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'hooks-'))
      const r = Bun.spawnSync(['sh', '-c', `${command} <&-`], {
        env: { PATH: process.env.PATH!, HOME: process.env.HOME!, CLAUDE_PLUGIN_ROOT: ROOT, TELEGRAM_STATE_DIR: dir, CLAUDE_PID: '4242' },
      })
      expect(r.exitCode).toBe(0)
      expect(r.stdout.toString()).toBe('')
      expect(readdirSync(dir)).toEqual([])
    })
  }
})
