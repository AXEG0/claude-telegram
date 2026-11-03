// The read command on planted call files, and as a command.
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { report } from './calls.ts'

const H = 3600_000
const END = Date.UTC(2026, 10, 2, 12, 0, 0)
const at = (t: number) => new Date(t).toISOString()
const l = (t: number, f: object) => JSON.stringify({ at: at(t), pid: 1, version: 'v', ...f })
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

// Two processes: 101 rotated, its .1 starting 20 h before the block, and 202
// live; a torn line; a hold of three 429s whose waits overlap in chat 1; a
// 429 in chat 2; a later 10 s hold in chat 1; the list's silent send (message
// 50) with 30 accepted and 6 not-modified edits; message 60 with 40 edits;
// chat 2's edit of a message 50; a call with no answer carrying lost: 3; a
// getMe; and a send into chat 2.
function planted(): string {
  const dir = mkdtempSync(join(tmpdir(), 'calls-test-'))
  dirs.push(dir)
  mkdirSync(join(dir, 'logs'))
  const block = END - 2 * H
  const a1: string[] = [], a0: string[] = [], b: string[] = []
  a1.push(l(block - 20 * H, { call: 'sendMessage', chat: '1', ok: true, message_id: 50, silent: true }))
  for (let i = 0; i < 30; i++) a1.push(l(block - 19 * H + i * 60_000, { call: 'editMessageText', chat: '1', ok: true, message_id: 50 }))
  for (let i = 0; i < 6; i++) a1.push(l(block - 18 * H + i * 10_000, { call: 'editMessageText', chat: '1', ok: false, message_id: 50, error_code: 400, not_modified: true }))
  a0.push(l(block - 30 * H, { call: 'sendChatAction', chat: '1', ok: true }))
  b.push(l(block - 3 * H, { call: 'sendMessage', chat: '1', ok: true, message_id: 60 }))
  for (let i = 0; i < 40; i++) b.push(l(block - 3 * H + (i + 1) * 60_000, { call: 'editMessageText', chat: '1', ok: true, message_id: 60 }))
  b.push(l(block - 3 * H, { call: 'editMessageText', chat: '2', ok: true, message_id: 50 }))
  b.push(l(block - 2 * H, { call: 'sendMessage', chat: '1', ok: null, error: 'HttpError/ECONNRESET', lost: 3 }))
  b.push(l(block - 2 * H, { call: 'getMe', ok: true }))
  b.push(l(block - 2 * H, { call: 'sendMessage', chat: '2', ok: true, message_id: 7 }))
  b.push('{"at":"2026-11-02T0')
  b.push(l(block, { call: 'sendMessage', chat: '1', ok: false, error_code: 429, retry_after: 1262 }))
  b.push(l(block + 600_000, { call: 'sendChatAction', chat: '1', ok: false, error_code: 429, retry_after: 700 }))
  b.push(l(block + 1200_000, { call: 'editMessageText', chat: '1', ok: false, error_code: 429, retry_after: 28728, message_id: 50 }))
  b.push(l(block + 100_000, { call: 'sendMessage', chat: '2', ok: false, error_code: 429, retry_after: 200 }))
  b.push(l(END + 9 * H, { call: 'sendMessage', chat: '1', ok: false, error_code: 429, retry_after: 10 }))
  writeFileSync(join(dir, 'logs', 'calls-101.jsonl.1'), a1.join('\n') + '\n')
  writeFileSync(join(dir, 'logs', 'calls-101.jsonl'), '')
  writeFileSync(join(dir, 'logs', 'calls-202.jsonl'), [...a0, ...b].join('\n') + '\n')
  return dir
}

describe('the read command', () => {
  test('reads both processes and the .1, and skips and counts the torn line', () => {
    const r = report(planted())
    expect(r).toContain('  calls-101.jsonl.1: 37 lines, 2026-11-01T14:00:00.000Z to 2026-11-01T16:00:50.000Z')
    expect(r).toContain('  calls-202.jsonl: 51 lines, 2026-11-01T04:00:00.000Z to 2026-11-02T21:00:00.000Z')
    expect(r).toContain('lines skipped: 1')
  })

  test('picks the long hold by its first refusal, not the later short one, and ends the window there', () => {
    const r = report(planted())
    expect(r).toContain('block: chat 1, first refusal 2026-11-02T10:00:00.000Z (sendMessage, wait 1262 s, ends 2026-11-02T10:21:02Z), lifts 2026-11-02T18:18:48Z')
    expect(r).toContain('window: 2026-11-01T10:00:00Z to 2026-11-02T10:00:00Z, chat 1')
    expect(r).toContain('  chat 1: from 2026-11-02T10:00:00.000Z to 2026-11-02T18:18:48Z, longest wait 28728 s, 3 refusals')
    expect(r).toContain('  chat 2: from 2026-11-02T10:01:40.000Z to 2026-11-02T10:05:00Z, longest wait 200 s, 1 refusals')
    expect(r).toContain('  chat 1: from 2026-11-02T21:00:00.000Z to 2026-11-02T21:00:10Z, longest wait 10 s, 1 refusals')
  })

  test('--to and --hours move the window', () => {
    const r = report(planted(), { to: END + 9 * H, hours: 1 })
    expect(r).not.toContain('block:')
    expect(r).toContain('window: 2026-11-02T20:00:00Z to 2026-11-02T21:00:00Z, every chat')
  })

  test("counts the list's edits by its silent send's chat and id, not-modified ones apart", () => {
    const r = report(planted())
    expect(r).toContain('  editMessageText (list): 30 accepted, 6 400 not modified, 0 no answer')
    expect(r).toContain('  editMessageText (other): 40 accepted, 0 refused, 0 no answer')
  })

  test("another chat's edit of the list message's id is no list edit", () => {
    const r = report(planted(), { chats: ['2'], to: END })
    expect(r).toContain('  editMessageText (other): 1 accepted, 0 refused, 0 no answer')
    expect(r).not.toContain('editMessageText (list)')
  })

  test("warns that the rotated process's kept lines start after the window's start", () => {
    expect(report(planted())).toContain('  warning: calls-101.jsonl rotated; its kept lines start 2026-11-01T14:00:00.000Z, after the window\'s start')
    expect(report(planted(), { to: END, hours: 10 })).not.toContain('warning:')
  })

  test('counts a call with no answer apart, sums lost lines, and totals other chats and calls naming none', () => {
    const r = report(planted())
    expect(r).toContain('lines skipped: 1; lines lost: 3')
    expect(r).toContain('  sendMessage: 2 accepted, 0 refused, 1 no answer')
    expect(r).toContain('  other chats: 2 calls, 2 accepted, 0 refused, 0 no answer')
    expect(r).toContain('  no chat: 1 calls, 1 accepted, 0 refused, 0 no answer')
  })

  test('prints calls per UTC hour, the first call of the window and exactly the last 20 before its end', () => {
    const r = report(planted())
    expect(r).toContain('  2026-11-02T08:00Z: sendMessage 1\n')
    expect(r).toContain('  2026-11-01T15:00Z: editMessageText (list) 30\n')
    expect(r).toContain('first call in the window: 2026-11-01T14:00:00.000Z sendMessage')
    const last = r.split('last calls before the end:\n')[1]!.trimEnd().split('\n')
    expect(last).toHaveLength(20)
    expect(last[0]).toBe('  2026-11-02T07:22:00.000Z editMessageText (other) ok')
    expect(last.at(-1)).toBe('  2026-11-02T08:00:00.000Z sendMessage no answer HttpError/ECONNRESET')
  })

  test('a folder planted where a call file goes is listed as unreadable, and every other file is read', () => {
    const dir = planted()
    // Listed first, so every file after it must still be read.
    mkdirSync(join(dir, 'logs', 'calls-100.jsonl'))
    const r = report(dir)
    expect(r).toContain('  calls-100.jsonl: unreadable, skipped')
    expect(r).toContain('  calls-101.jsonl.1: 37 lines')
    expect(r).toContain('  calls-202.jsonl: 51 lines')
    expect(r).toContain('block: chat 1, first refusal 2026-11-02T10:00:00.000Z')
  })
})

describe('the read command, as a command', () => {
  test('reads --to with no zone as UTC, with T or a space, refuses other forms and days past their month, lower-cases a @name, and prints its usage on stdout with exit 1', () => {
    const dir = planted()
    const run = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dir, 'calls.ts'), '--state', dir, ...args], { encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Dubai' } })
    expect(run('--to', '2026-11-02T21:00', '--hours', '1').stdout).toContain('window: 2026-11-02T20:00:00Z to 2026-11-02T21:00:00Z')
    expect(run('--to', '2026-11-02 21:00:00', '--hours', '1').stdout).toContain('window: 2026-11-02T20:00:00Z to 2026-11-02T21:00:00Z')
    expect(run('--to', '2026-11-02T21:00+04:00', '--hours', '1').stdout).toContain('window: 2026-11-02T16:00:00Z to 2026-11-02T17:00:00Z')
    for (const bad of ['2026-11-02T21:00+04', '2026-11-02T21:00+0400', '2026-02-30 10:00', '2026-11-31']) {
      const r = run('--to', bad, '--hours', '1')
      expect([bad, r.status, r.stdout]).toEqual([bad, 1, expect.stringMatching(/^usage: bun calls\.ts/)])
    }
    expect(run('--to', '2026-02-28 10:00', '--hours', '1').stdout).toContain('window: 2026-02-28T09:00:00Z to 2026-02-28T10:00:00Z')
    expect(run('--chat', '@Some_Peer', '--to', '2026-11-02T21:00Z').stdout).toContain(', chat @some_peer\n')
    const bad = run('--hours')
    expect(bad.status).toBe(1)
    expect(bad.stdout).toStartWith('usage: bun calls.ts')
    expect(bad.stderr).toBe('')
  })
})
