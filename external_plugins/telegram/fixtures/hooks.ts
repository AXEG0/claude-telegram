// Runs each command hooks/hooks.json registers for an event the way Claude
// Code does: through a shell, with CLAUDE_PLUGIN_ROOT set and the hook input
// on stdin. A test that runs the hooks this way also proves their
// registration.
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { onDrivenClock, stamp } from './harness.ts'

const ROOT = join(import.meta.dir, '..')

type Group = { matcher?: string; hooks: { type: string; command: string }[] }

export function registered(event: string): string[] {
  const groups: Group[] = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks[event] ?? []
  return groups.filter(g => g.matcher === undefined).flatMap(g => g.hooks.map(h => h.command))
}

// The exit code of each registered command, in the order hooks.json lists them.
// On the driven clock a hook reads the test's time. A marker the hook wrote
// gets the kernel's real time, the same as its change time; it becomes that
// moment on the test's clock, as the server reads markers by their mtime. A
// time the hook gave a marker itself differs from the change time the kernel
// set then; it is already on the test's clock the hook reads, and stays.
export function runRegistered(event: string, input: object, env: Record<string, string>): (number | null)[] {
  const clock = onDrivenClock()
    ? { BUN_OPTIONS: `--preload ${join(import.meta.dir, 'pin-clock.ts')}`, TELEGRAM_TEST_CLOCK_NOW: String(Date.now()) }
    : {}
  const turns = env.TELEGRAM_STATE_DIR ? join(env.TELEGRAM_STATE_DIR, 'turns') : undefined
  const before = new Map(markers(turns))
  const codes = registered(event).map(command => Bun.spawnSync(['sh', '-c', command], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, CLAUDE_PLUGIN_ROOT: ROOT, ...clock, ...env },
  }).exitCode)
  if (onDrivenClock()) {
    for (const [file, mtime] of markers(turns)) {
      if (before.get(file) === mtime) continue
      const times = statSync(file, { bigint: true })
      if (times.mtimeNs === times.ctimeNs) stamp(file)
    }
  }
  return codes
}
function markers(dir: string | undefined): [string, number][] {
  if (!dir) return []
  try { return readdirSync(dir).map(name => [join(dir, name), statSync(join(dir, name)).mtimeMs]) } catch { return [] }
}
