#!/usr/bin/env bun
// Stop, StopFailure and SessionEnd hook: records that this session's turn has
// ended, so the server stops re-sending "typing…". See typing.ts. Always
// exits 0; a hook failure must never block Claude.

import { readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { hookClaudePid, markerFiles, stateDir, writeTurnEnd } from '../typing.ts'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

try {
  let sessionId: string | undefined
  try {
    sessionId = JSON.parse(readFileSync(0, 'utf8')).session_id
  } catch {}
  const pid = hookClaudePid()
  const dir = stateDir()
  writeTurnEnd(markerFiles(dir, sessionId, pid ? [pid] : []))

  const turns = join(dir, 'turns')
  const now = Date.now()
  for (const name of readdirSync(turns)) {
    const f = join(turns, name)
    if (now - statSync(f).mtimeMs > WEEK_MS) rmSync(f, { force: true })
  }
} catch {}
process.exit(0)
