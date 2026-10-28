import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, truncateSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { failureFiles } from './failures.ts'
import turnHooks from './fixtures/turn-hooks.json'
import { createLogFollower } from './log-follower.ts'

const made: string[] = []
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'log-follower-')); made.push(dir); return dir }
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }) })

// A failure record's line; each `t` of 13 digits gives the same length.
const line = (t: number) => JSON.stringify({ t, error: 'unknown', text: 'API Error: 402 Insufficient credits. Add more credits to continue.' })

// A failure log under outcomes/, as the turn-end hook writes it.
function log(): string {
  const dir = scratch()
  mkdirSync(join(dir, 'outcomes'))
  return failureFiles(dir, [4242])[0]!
}

describe('a followed log', () => {
  test('swept by the turn-end hook after a week and written again at the same length is read from its start', () => {
    const file = log()
    const dir = join(file, '..', '..')
    appendFileSync(file, line(1_700_000_000_001) + '\n')
    const follower = createLogFollower(file)
    expect(follower.read()).toEqual([line(1_700_000_000_001)])
    const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    utimesSync(file, weekAgo, weekAgo)
    const stop = Bun.spawnSync(['bun', join(import.meta.dir, 'hooks', 'turn-end.ts')], {
      stdin: new TextEncoder().encode(JSON.stringify(turnHooks.stop_after_402)),
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, TELEGRAM_STATE_DIR: dir, CLAUDE_PID: '4242' },
    })
    expect(stop.exitCode).toBe(0)
    expect(existsSync(file)).toBe(false)
    appendFileSync(file, line(1_700_000_000_002) + '\n')
    expect(follower.waiting()).toBe(true)
    expect(follower.read()).toEqual([line(1_700_000_000_002)])
    expect(follower.waiting()).toBe(false)
    follower.close()
  })

  test('moved away and replaced is read from the new file\'s start, after the old file\'s unread lines', () => {
    const file = log()
    appendFileSync(file, line(1_700_000_000_001) + '\n')
    const follower = createLogFollower(file)
    expect(follower.read()).toEqual([line(1_700_000_000_001)])
    appendFileSync(file, line(1_700_000_000_002) + '\n')
    renameSync(file, `${file}.1`)
    appendFileSync(file, line(1_700_000_000_003) + '\n')
    expect(follower.read()).toEqual([line(1_700_000_000_002), line(1_700_000_000_003)])
    expect(follower.read()).toEqual([])
    follower.close()
  })

  test('cut back in place is read from its start, and a line not yet ended waits for its end', () => {
    const file = log()
    appendFileSync(file, line(1_700_000_000_001) + '\n' + line(1_700_000_000_002) + '\n')
    const follower = createLogFollower(file)
    expect(follower.read()).toHaveLength(2)
    truncateSync(file, 0)
    appendFileSync(file, line(1_700_000_000_003).slice(0, 20))
    expect(follower.waiting()).toBe(true)
    expect(follower.read()).toEqual([])
    appendFileSync(file, line(1_700_000_000_003).slice(20) + '\n')
    expect(follower.read()).toEqual([line(1_700_000_000_003)])
    follower.close()
  })

  test('a log not written yet reads as empty until it is', () => {
    const file = log()
    const follower = createLogFollower(file)
    expect(follower.waiting()).toBe(false)
    expect(follower.read()).toEqual([])
    appendFileSync(file, line(1_700_000_000_001) + '\n')
    expect(follower.waiting()).toBe(true)
    expect(follower.read()).toEqual([line(1_700_000_000_001)])
    follower.close()
  })
})
