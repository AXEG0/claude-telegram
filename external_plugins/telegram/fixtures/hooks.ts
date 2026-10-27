// Runs each command hooks/hooks.json registers for an event the way Claude
// Code does: through a shell, with CLAUDE_PLUGIN_ROOT set and the hook input
// on stdin. A test that runs the hooks this way also proves their
// registration.
import { readFileSync } from 'fs'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..')

type Group = { matcher?: string; hooks: { type: string; command: string }[] }

export function registered(event: string): string[] {
  const groups: Group[] = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks[event] ?? []
  return groups.filter(g => g.matcher === undefined).flatMap(g => g.hooks.map(h => h.command))
}

// The exit code of each registered command, in the order hooks.json lists them.
export function runRegistered(event: string, input: object, env: Record<string, string>): (number | null)[] {
  return registered(event).map(command => Bun.spawnSync(['sh', '-c', command], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, CLAUDE_PLUGIN_ROOT: ROOT, ...env },
  }).exitCode)
}
