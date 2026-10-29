import { describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ARRIVALS_BOUND, createArrivals, KEPT_MS, type ArrivalsIo, type DoneSeed } from './arrivals.ts'

const T = 1_800_000_000_000
const file = () => join(mkdtempSync(join(tmpdir(), 'tg-arrivals-')), 'arrivals.jsonl')
const lines = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const update = (id: number, pad = 0) => ({ update_id: id, message: { message_id: id, date: T / 1000, text: `m${id}`, pad: 'x'.repeat(pad) } })
const seed = (id: number): DoneSeed => ({ update_id: id, chat_id: '1', message_id: String(id), kind: 'text', arrived: T, queued: 0, handed: T, outcome: 'delivered' })
// The update id and kind of each line, in order.
const kinds = (path: string) => lines(path).map(l => `${l.line}:${l.update_id}`)
const start = (rec: ReturnType<typeof createArrivals>, id: number, pad = 0) => rec.start(update(id, pad), T, T)
// Finished entries from id 1 on, until the file is within 40 KB of the bound;
// returns the next free id.
function fillUnder(rec: ReturnType<typeof createArrivals>, path: string): number {
  let id = 1
  do { start(rec, id, 30_000); rec.done(seed(id)); id++ } while (readFileSync(path, 'utf8').length < ARRIVALS_BOUND - 40_000)
  return id
}

describe('the record of arrivals', () => {
  test('R2 a compaction replaces the file through a temp file: a write that fails half way leaves every unfinished start line', () => {
    // Finished entries just under the bound and 500 unfinished; 501's start
    // line crosses the bound.
    const fill = (rec: ReturnType<typeof createArrivals>, path: string) => { const n = fillUnder(rec, path); start(rec, 500); return n }
    const real = file()
    const realRec = createArrivals(real, { now: () => T, log: () => {} })
    const n = fill(realRec, real)
    const before = readFileSync(real, 'utf8')
    start(realRec, 501, 60_000)
    expect(readFileSync(`${real}.1`, 'utf8').startsWith(before)).toBe(true)
    expect(kinds(`${real}.1`).length).toBe(2 * (n - 1) + 2)
    expect(kinds(real)).toEqual(['start:500', 'start:501'])

    // The same, with a write that puts down half of what it is given and throws.
    const failing = file()
    const reports: string[] = []
    const half: Partial<ArrivalsIo> = {
      write: (path, data) => { writeFileSync(path, data.slice(0, data.length / 2)); throw new Error('ENOSPC: no space left on device') },
    }
    const failingRec = createArrivals(failing, { now: () => T, log: l => reports.push(l), io: half })
    fill(failingRec, failing)
    start(failingRec, 501, 60_000)
    const unfinished = lines(failing).filter(l => l.line === 'start' && l.update_id >= 500).map(l => l.update_id)
    expect(unfinished).toEqual([500, 501])
    expect(reports.some(r => r.includes('not compacted') && r.includes('ENOSPC'))).toBe(true)
    expect(createArrivals(failing, { now: () => T, log: () => {} }).open().replay.map(e => e.update_id)).toEqual([500, 501])
  })

  test('R3 a replayed handler that writes nothing gets a replayed line after it; one that writes its own line gets none', async () => {
    const path = file()
    const rec = createArrivals(path, { now: () => T, log: () => {} })
    start(rec, 1)
    start(rec, 2)
    const order: string[] = []
    const { replay } = createArrivals(path, { now: () => T, log: () => {} }).open()
    await rec.replay(replay, async u => {
      const id = (u as { update_id: number }).update_id
      order.push(`handled:${id}:${kinds(path).filter(k => k === `replayed:${id}`).length}`)
      if (id === 2) start(rec, 2)
    })
    expect(order).toEqual(['handled:1:0', 'handled:2:0'])
    expect(kinds(path)).toEqual(['start:1', 'start:2', 'replayed:1', 'start:2'])
  })

  test('R3 a replayed handler whose start line sets off a compaction gets no replayed line', async () => {
    const path = file()
    const rec = createArrivals(path, { now: () => T, log: () => {} })
    // Finished entries just under the bound, and one unfinished entry.
    fillUnder(rec, path)
    start(rec, 999)
    const { replay } = rec.open()
    expect(replay.map(e => e.update_id)).toEqual([999])
    // The handler's own start line is the append that crosses the bound.
    await rec.replay(replay, async () => { start(rec, 999, 60_000) })
    expect(existsSync(`${path}.1`)).toBe(true)
    const own = lines(path).filter(l => l.update_id === 999).map(l => l.line)
    expect(own).not.toContain('replayed')
    expect(own.at(-1)).toBe('start')
  })

  test('R4 a record whose writes and reads fail reports each failure once and never throws', async () => {
    const reports: string[] = []
    const enospc = () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }) }
    const rec = createArrivals(file(), { now: () => T, log: l => reports.push(l), io: { append: enospc, read: enospc } })
    expect(() => start(rec, 1)).not.toThrow()
    expect(() => rec.done(seed(1))).not.toThrow()
    let opened: ReturnType<typeof rec.open> | undefined
    expect(() => { opened = rec.open() }).not.toThrow()
    expect(opened!.replay).toEqual([])
    await rec.replay([{ line: 'start', update_id: 3, sent: T, arrived: T, at: T, update: update(3) }], async () => {})
    expect(reports.filter(r => r.includes('not written'))).toHaveLength(3)
    expect(reports.filter(r => r.includes('not read'))).toHaveLength(2)
  })

  test('R4 after a compaction fails, the next append does not try it again', () => {
    const path = file()
    let writes = 0
    const reports: string[] = []
    const rec = createArrivals(path, { now: () => T, log: l => reports.push(l), io: { write: () => { writes++; throw new Error('ENOSPC: no space left on device') } } })
    for (let id = 1; writes === 0 && id < 200; id++) start(rec, id, 30_000)
    expect(writes).toBe(1)
    start(rec, 500)
    expect(writes).toBe(1)
    expect(reports.filter(r => r.includes('not compacted'))).toHaveLength(1)
  })

  test('R5 appends past the bound compact the file while running, and the next open skips the finished entries moved aside', () => {
    const path = file()
    const rec = createArrivals(path, { now: () => T, log: () => {} })
    start(rec, 1)
    start(rec, 2)
    let id = 3
    let before = ''
    for (; !existsSync(`${path}.1`) && id < 200; id++) {
      before = readFileSync(path, 'utf8')
      start(rec, id, 30_000)
      rec.done(seed(id))
    }
    expect(existsSync(`${path}.1`)).toBe(true)
    const size = readFileSync(path, 'utf8').length
    expect(size).toBeLessThan(ARRIVALS_BOUND)
    expect(kinds(path).slice(0, 2)).toEqual(['start:1', 'start:2'])
    expect(readFileSync(`${path}.1`, 'utf8').startsWith(before)).toBe(true)
    const { replay, skip } = createArrivals(path, { now: () => T, log: () => {} }).open()
    expect(replay.map(e => e.update_id)).toEqual([1, 2])
    expect(skip.has(3)).toBe(true)
    expect(skip.has(id - 2)).toBe(true)
  })

  test('R5 an entry in flight at a compaction and finished after it is not replayed, and is skipped', () => {
    const path = file()
    const rec = createArrivals(path, { now: () => T, log: () => {} })
    fillUnder(rec, path)
    // 900 is in its work when 901's start line crosses the bound.
    start(rec, 900)
    start(rec, 901, 60_000)
    expect(existsSync(`${path}.1`)).toBe(true)
    rec.done(seed(901))
    rec.done(seed(900))
    const { replay, skip } = createArrivals(path, { now: () => T, log: () => {} }).open()
    expect(replay).toEqual([])
    expect(skip.has(900)).toBe(true)
    expect(skip.has(901)).toBe(true)
  })

  test('R6 an append after a line cut short, by the file or by a failed append, reads back whole', () => {
    const torn = file()
    writeFileSync(torn, `${JSON.stringify({ line: 'start', update_id: 1, sent: T, arrived: T, at: T, update: update(1) })}\n{"line":"done","upda`)
    const rec = createArrivals(torn, { now: () => T, log: () => {} })
    rec.open()
    start(rec, 2)
    expect(createArrivals(torn, { now: () => T, log: () => {} }).open().replay.map(e => e.update_id)).toEqual([1, 2])

    const cut = file()
    let first = true
    const halfAppend: Partial<ArrivalsIo> = {
      append: (path, data) => {
        if (!first) return appendFileSync(path, data)
        first = false
        appendFileSync(path, data.slice(0, data.length / 2))
        throw new Error('ENOSPC: no space left on device')
      },
    }
    const cutRec = createArrivals(cut, { now: () => T, log: () => {}, io: halfAppend })
    start(cutRec, 1)
    start(cutRec, 2)
    expect(createArrivals(cut, { now: () => T, log: () => {} }).open().replay.map(e => e.update_id)).toEqual([2])
  })

  test('an entry over 24 h old gets a done line and is not handed in, and only younger ids are skipped', async () => {
    const path = file()
    const rec = createArrivals(path, { now: () => T, log: () => {} })
    rec.start(update(1), T - KEPT_MS - 1, T - 1000)
    rec.start(update(2), T - KEPT_MS + 60_000, T - 1000)
    const { replay, skip } = rec.open()
    const handed: number[] = []
    await rec.replay(replay, async u => { handed.push((u as { update_id: number }).update_id) })
    expect(handed).toEqual([2])
    expect(lines(path).find(l => l.line === 'done' && l.update_id === 1)?.outcome).toBe('not replayed')
    expect([...skip]).toEqual([2])
  })
})
