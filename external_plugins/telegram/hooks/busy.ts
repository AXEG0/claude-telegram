#!/usr/bin/env bun
// PreToolUse, PostToolUse, PostToolUseFailure and UserPromptSubmit hook: marks
// this Claude Code process busy, so the Telegram server types while a turn
// runs, whoever started it. The mark at a tool call's end restarts the stuck
// clock after a long call, which the mark at its start alone would not. A
// subagent's tool call carries agent_id and marks it only as working on: that
// keeps a chat that is already typing clear of the stuck notice, and starts
// nothing, as subagents have their own messages. Run by hand with nothing,
// text, or JSON that names none of its own events or lacks a non-empty text
// session_id, it writes nothing; an object with its own event and such a
// session_id, built by hand, still marks as a real hook would. See typing.ts,
// hookInput included. Always exits 0; a hook failure must never block Claude.

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { BUSY_EVENTS, busyFiles, hookClaudePid, hookInput, stateDir, subagentFiles } from '../typing.ts'

try {
  const input = hookInput(readFileSync(0, 'utf8'), BUSY_EVENTS)
  if (!input) process.exit(0)
  const pid = hookClaudePid()
  const [file] = (input.agent_id ? subagentFiles : busyFiles)(stateDir(), pid ? [pid] : [])
  if (file) {
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(file, '')
  }
} catch {}
process.exit(0)
