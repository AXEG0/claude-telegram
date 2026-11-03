// The server log's guard: the writer takes process.stderr.write, console.error and
// console.warn at setup, so those are captured whatever their spelling. The
// guard bans what that capture cannot see: the console itself (its other
// methods print to stdout, the MCP pipe, or to stderr past the capture) and
// the literal spellings of descriptor 2. Every line, comments included, in
// every .ts file except the writer's, hooks/, fixtures/ and *.test.ts.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
const BANNED = /\bconsole\b|\bBun\.stderr\b|\bBun\.file\(\s*2\s*\)|\bwriteSync\(\s*2\b|\/dev\/(stderr|fd\/2)\b|\/proc\/self\/fd\/2\b/
const WORKER_BANNED = new RegExp(`${BANNED.source}|\\bstderr\\b`)
test('no line prints past the writer', () => {
  const hits: string[] = []
  const files = readdirSync(import.meta.dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'log.ts')
  expect(files).toContain('server.ts')
  expect(files).toContain('rich-worker.ts')
  for (const f of files) {
    // The rich worker runs in a thread of its own, whose stderr the capture never takes.
    const banned = f === 'rich-worker.ts' ? WORKER_BANNED : BANNED
    readFileSync(join(import.meta.dir, f), 'utf8').split('\n').forEach((line, i) => { if (banned.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`) })
  }
  expect(hits).toEqual([])
})
