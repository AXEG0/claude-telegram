#!/usr/bin/env bun
// Stop, StopFailure and SessionEnd hook: records that this session's turn has
// ended, so the server stops re-sending "typing…". See typing.ts. A
// subagent's StopFailure carries the subagent's agent_id and ends only that
// subagent, which hooks/subagent.ts records; the session's turn goes on. The
// main session's StopFailure also records its error, and Stop its clean end,
// for the server's failure notice; see failures.ts. Run by hand with nothing,
// text, or JSON that names none of its own events or lacks a non-empty text
// session_id, it writes nothing; an object with its own event and such a
// session_id, built by hand, still marks as a real hook would (see hookInput in
// typing.ts). Always exits 0; a hook failure must never block Claude.

import { readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { appendFailure, cleanFiles, cleanRecord, failureFiles, failureRecord, writeClean } from '../failures.ts'
import { hookClaudePid, hookInput, markerFiles, stateDir, TURN_END_EVENTS, writeTurnEnd } from '../typing.ts'

// The records carry the time the hook started, the nearest to the turn's end.
const at = Date.now()
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

try {
  const input = hookInput(readFileSync(0, 'utf8'), TURN_END_EVENTS)
  if (!input) process.exit(0)
  if (input.hook_event_name === 'StopFailure' && input.agent_id) process.exit(0)
  const sessionId = input.session_id
  const pid = hookClaudePid()
  const dir = stateDir()
  const pids = pid ? [pid] : []
  try {
    const [log] = failureFiles(dir, pids)
    if (input.hook_event_name === 'StopFailure' && log) appendFailure(log, failureRecord(input, at))
    if (input.hook_event_name === 'Stop') writeClean(cleanFiles(dir, sessionId, pids), cleanRecord(input, at))
  } catch {}
  writeTurnEnd(markerFiles(dir, sessionId, pids))

  const now = Date.now()
  for (const folder of ['turns', 'outcomes']) {
    let names: string[]
    try { names = readdirSync(join(dir, folder)) } catch { continue }
    for (const name of names) {
      const f = join(dir, folder, name)
      if (now - statSync(f).mtimeMs > WEEK_MS) rmSync(f, { force: true })
    }
  }
} catch {}
process.exit(0)
