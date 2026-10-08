// Keeps Telegram's "typing…" on from an inbound message until Claude's turn
// ends. Telegram clears the indicator after about 5 seconds, or as soon as
// the bot sends a message, so it is re-sent every REFRESH_MS while the turn
// runs. The plugin's Stop, StopFailure and SessionEnd hook (hooks/turn-end.ts)
// marks the end of a turn by writing the time into a file named for the
// session; the server reads only the files that name its own session.
//
// This file carries no dependencies beyond Node's, so the hook can import it
// before `bun install` has run.

import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const REFRESH_MS = 4000
// A turn whose end never reaches the hook (an interrupt, a hung turn) stops
// typing here, and onCap tells the chat.
export const CAP_MS = 30 * 60 * 1000

// The same directory server.ts computes as STATE_DIR, for the hook.
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TELEGRAM_STATE_DIR
    ?? join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'channels', 'telegram')
}

// A session is named twice: by its session id, and by the pid of the Claude
// Code process, which survives /clear when the session id changes.
export function markerFiles(dir: string, sessionId?: string, claudePid?: number): string[] {
  const files: string[] = []
  if (sessionId && /^[\w-]+$/.test(sessionId)) files.push(join(dir, 'turns', `session-${sessionId}`))
  if (claudePid && claudePid > 1) files.push(join(dir, 'turns', `pid-${claudePid}`))
  return files
}

export function writeTurnEnd(files: string[], at: number = Date.now()): void {
  for (const f of files) {
    mkdirSync(join(f, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(f, String(at))
  }
}

export function readTurnEnd(files: string[]): number {
  let latest = 0
  for (const f of files) {
    try {
      const at = parseInt(readFileSync(f, 'utf8'), 10)
      if (at > latest) latest = at
    } catch {}
  }
  return latest
}

// The nearest ancestor named `claude`, walking at most a few parents. The
// server starts under a `bun run` wrapper; a hook under a shell.
export function findClaudePid(start: number = process.ppid): number | undefined {
  let pid = start
  for (let i = 0; i < 4 && pid > 1; i++) {
    try {
      const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      const m = /^(\d+)\s+(.*)$/.exec(out)
      if (!m) return undefined
      if (/(^|\/)claude$/.test(m[2]!)) return pid
      pid = parseInt(m[1]!, 10)
    } catch {
      return undefined
    }
  }
  return undefined
}

export type Typing = {
  start(chatId: string): void
  tick(): void
  pause(): void
  resume(): void
  active(): string[]
}

export function createTyping(opts: {
  send: (chatId: string) => void
  turnEndedAt: () => number
  onCap?: (chatId: string) => void
  now?: () => number
  capMs?: number
}): Typing {
  const now = opts.now ?? Date.now
  const capMs = opts.capMs ?? CAP_MS
  const since = new Map<string, number>()
  let paused = false

  return {
    start(chatId) {
      since.set(chatId, now())
      if (!paused) opts.send(chatId)
    },
    tick() {
      if (since.size === 0) return
      const ended = opts.turnEndedAt()
      const t = now()
      for (const [chatId, began] of since) {
        if (ended >= began) {
          since.delete(chatId)
          continue
        }
        if (t - began >= capMs) {
          since.delete(chatId)
          opts.onCap?.(chatId)
          continue
        }
        if (!paused) opts.send(chatId)
      }
      if (since.size === 0) paused = false
    },
    // A permission prompt waits on the owner, not on Claude. With no chat
    // typing there is nothing to hold, and no tick would clear the pause.
    pause() {
      if (since.size > 0) paused = true
    },
    resume() {
      paused = false
    },
    active() {
      return [...since.keys()]
    },
  }
}
