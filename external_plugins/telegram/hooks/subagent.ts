#!/usr/bin/env bun
// SubagentStart and SubagentStop hook: appends the event to a file named for
// this Claude Code process, which the server follows to stream subagents to
// Telegram. See agents.ts. Always exits 0; a hook failure must never block
// Claude.

import { readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { agentEventFile, appendAgentEvent, eventFromHook } from '../agents.ts'
import { hookClaudePid, stateDir } from '../typing.ts'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

try {
  const ev = eventFromHook(JSON.parse(readFileSync(0, 'utf8')))
  const pid = hookClaudePid()
  if (ev && pid) {
    const file = agentEventFile(stateDir(), pid)
    appendAgentEvent(file, ev)
    const dir = join(file, '..')
    const now = Date.now()
    for (const name of readdirSync(dir)) {
      const f = join(dir, name)
      if (now - statSync(f).mtimeMs > WEEK_MS) rmSync(f, { force: true })
    }
  }
} catch {}
process.exit(0)
