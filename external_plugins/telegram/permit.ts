// A session in bypass mode still meets Claude Code's asks for a command it
// cannot check, such as a `bash -c` script it cannot read for removals. Its
// mode already says the user wants no asks, so in the channel session the
// plugin's PermissionRequest hook (hooks/permission.ts) answers a Bash ask
// itself: it appends what it allowed to a file named for the Claude Code pid,
// then allows the call. The polling server reads its ancestors' files and
// tells the allowlisted chats what ran, with the command one tap away:
//
//   🔓 Allowed · Bash · general-purpose agent
//   Push job archive to rental and check environment
//
// Any other mode, session or tool, and any failure, leaves the ask as it is.
//
// This file carries no dependencies beyond Node's, so the hook can import it
// before `bun install` has run.

import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from 'fs'
import { join } from 'path'

export type PermitEvent = {
  t: number
  event: 'allowed'
  tool_name: string
  // Claude's description of the call; Claude Code relays the same text.
  description?: string
  command?: string
  // Set when a subagent made the call.
  agent_type?: string
}

export const ALLOW_OUTPUT = JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
})

// Telegram's limit for one message.
export const PERMIT_MESSAGE_LIMIT = 4096

export function permitFile(dir: string, pid: number): string {
  return join(dir, 'permits', `pid-${pid}.jsonl`)
}

export function appendPermit(file: string, ev: PermitEvent): void {
  mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
  appendFileSync(file, JSON.stringify(ev) + '\n')
}

// Hook input → the call to allow, or undefined to leave the ask as it is.
export function permitFromHook(input: {
  hook_event_name?: unknown
  permission_mode?: unknown
  tool_name?: unknown
  tool_input?: unknown
  agent_type?: unknown
}, channel: boolean, now: number = Date.now()): PermitEvent | undefined {
  if (!channel) return undefined
  if (input.hook_event_name !== 'PermissionRequest') return undefined
  if (input.permission_mode !== 'bypassPermissions') return undefined
  if (input.tool_name !== 'Bash') return undefined
  const args = (input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}) as
    { description?: unknown; command?: unknown }
  const ev: PermitEvent = { t: now, event: 'allowed', tool_name: 'Bash' }
  if (typeof args.description === 'string' && args.description.trim()) ev.description = args.description.trim()
  if (typeof args.command === 'string') ev.command = args.command
  if (typeof input.agent_type === 'string' && input.agent_type) ev.agent_type = input.agent_type
  return ev
}

export function permitText(ev: PermitEvent): string {
  const who = ev.agent_type ? `${ev.agent_type} agent` : 'main session'
  return `🔓 Allowed · ${ev.tool_name} · ${who}\n${ev.description ?? 'Run shell command'}`
}

// The notice with the command under it, cut to fit one message.
export function permitDetail(ev: PermitEvent): string {
  const head = `${permitText(ev)}\n\n`
  const command = ev.command ?? ''
  const room = PERMIT_MESSAGE_LIMIT - head.length
  return head + (command.length > room ? `${command.slice(0, room - 1)}…` : command)
}

// Reads the events appended to each file since the reader was made.
export function createPermitReader(files: string[]) {
  const offsets = new Map<string, number>()
  for (const f of files) {
    let size = 0
    try { size = statSync(f).size } catch {}
    offsets.set(f, size)
  }
  return (): PermitEvent[] => {
    const out: PermitEvent[] = []
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
          const ev = JSON.parse(line) as PermitEvent
          if (ev.event === 'allowed' && typeof ev.tool_name === 'string' && ev.tool_name) out.push(ev)
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
