#!/usr/bin/env bun
// PreToolUse and UserPromptSubmit hook: marks this Claude Code process busy,
// so the Telegram server types while a turn runs, whoever started it. A
// subagent's tool call carries agent_id and marks it only as working on: that
// keeps a chat that is already typing clear of the stuck notice, and starts
// nothing, as subagents have their own messages. See typing.ts. Always exits
// 0; a hook failure must never block Claude.

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { busyFiles, hookClaudePid, stateDir, subagentFiles } from '../typing.ts'

try {
  let input: { agent_id?: unknown } = {}
  try {
    input = JSON.parse(readFileSync(0, 'utf8'))
  } catch {}
  const pid = hookClaudePid()
  const [file] = (input.agent_id ? subagentFiles : busyFiles)(stateDir(), pid ? [pid] : [])
  if (file) {
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(file, '')
  }
} catch {}
process.exit(0)
