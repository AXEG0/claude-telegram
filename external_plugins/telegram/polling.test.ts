import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CHANNEL_ENTRY, channelMode } from './polling.ts'
import fixture from './fixtures/channel-argv.json'

const dirs: string[] = []
function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-proc-'))
  dirs.push(dir)
  return dir
}
function processAt(dir: string, pid: number, parent: number, argv: string[], comm = 'process'): void {
  const entry = join(dir, String(pid))
  mkdirSync(entry, { recursive: true })
  writeFileSync(join(entry, 'cmdline'), argv.join('\0') + '\0')
  writeFileSync(join(entry, 'stat'), `${pid} (${comm}) S ${parent} 0 0 0\n`)
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('polling ownership from the server\'s own ancestors', () => {
  test('the real argylle2 channel argv, through its bun-run wrapper, polls', () => {
    const dir = tree()
    processAt(dir, 20, 30, ['bun', 'run', '--cwd', '/plugin', '--silent', 'start'])
    processAt(dir, 30, 1, fixture.argv)
    expect(channelMode(20, dir)).toEqual({ poll: true })
  })

  test.each([
    ['claude', '-p', 'hello'],
    ['/home/ec2-user/.local/bin/claude', 'mcp', 'list'],
    ['claude', '--continue'],
    ['claude', '-p', `explain ${CHANNEL_ENTRY}`],
    ['claude', '--channels=' + CHANNEL_ENTRY],
    ['claude', CHANNEL_ENTRY + '-other'],
  ])('a session without the exact channel entry is send-only: %j', (...argv) => {
    const dir = tree()
    processAt(dir, 20, 1, argv)
    expect(channelMode(20, dir)).toEqual({ poll: false })
  })

  test('an absolute claude path with the exact channel entry polls', () => {
    const dir = tree()
    processAt(dir, 20, 1, ['/usr/local/bin/claude', '--channels', CHANNEL_ENTRY])
    expect(channelMode(20, dir)).toEqual({ poll: true })
  })

  test('a nested claude -p does not inherit its outer session\'s channel', () => {
    const dir = tree()
    processAt(dir, 20, 30, ['claude', '-p', 'hello'])
    processAt(dir, 30, 1, fixture.argv)
    expect(channelMode(20, dir)).toEqual({ poll: false })
  })

  test('an unrelated process with the channel entry does not enable polling', () => {
    const dir = tree()
    processAt(dir, 20, 1, ['claude-helper', CHANNEL_ENTRY])
    expect(channelMode(20, dir)).toEqual({ poll: false })
  })

  test('readable ancestors without Claude are send-only, including unusual comm', () => {
    const dir = tree()
    processAt(dir, 20, 30, ['bun', 'server.ts'], 'bun (run) wrapper')
    processAt(dir, 30, 1, ['bash'])
    expect(channelMode(20, dir)).toEqual({ poll: false })
  })

  test('an unreadable process tree keeps polling with a loud warning', () => {
    const result = channelMode(20, tree())
    expect(result.poll).toBe(true)
    expect(result.warning).toContain('WARNING: cannot read Claude ancestor process tree; polling as before')
  })

  test('a missing ancestor is uncertain, not a readable non-channel tree', () => {
    const dir = tree()
    processAt(dir, 20, 30, ['bun'])
    expect(channelMode(20, dir).warning).toContain('WARNING')
  })

  test('a malformed stat or a cyclic tree warns instead of hanging', () => {
    const dir = tree()
    processAt(dir, 20, 20, ['bun'])
    expect(channelMode(20, dir).warning).toContain('invalid ancestor chain')
    writeFileSync(join(dir, '20', 'stat'), 'broken')
    expect(channelMode(20, dir).warning).toContain('invalid parent')
  })
})
