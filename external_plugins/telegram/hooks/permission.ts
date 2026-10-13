#!/usr/bin/env bun
// PermissionRequest hook (Bash): in the channel session, in bypass mode,
// records the call for the server's notice and allows it. Anything else, and
// any failure, prints nothing, so Claude Code asks as it would without this
// hook. The record is written before the answer, so nothing is allowed
// without its notice. See permit.ts.

import { readdirSync, readFileSync, rmSync, statSync, writeSync } from 'fs'
import { join } from 'path'
import { ALLOW_OUTPUT, appendPermit, permitFile, permitFromHook } from '../permit.ts'
import { channelMode } from '../polling.ts'
import { hookClaudePid, stateDir } from '../typing.ts'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

try {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const mode = channelMode()
  // channelMode polls when it cannot read the process tree; allowing needs
  // the tree read.
  const ev = permitFromHook(input, mode.poll && !mode.warning)
  const pid = hookClaudePid()
  if (ev && pid) {
    const file = permitFile(stateDir(), pid)
    appendPermit(file, ev)
    writeSync(1, ALLOW_OUTPUT + '\n')
    try {
      const dir = join(file, '..')
      const now = Date.now()
      for (const name of readdirSync(dir)) {
        const f = join(dir, name)
        if (now - statSync(f).mtimeMs > WEEK_MS) rmSync(f, { force: true })
      }
    } catch {}
  }
} catch {}
process.exit(0)
