import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { flock, LOCK_EX, LOCK_NB } from './buttons.ts'
import { createPanelStore } from './panels.ts'
import type { SweepSlots } from './agents.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { chmodSync(d, 0o700) } catch {}
    rmSync(d, { recursive: true, force: true })
  }
})
const folder = () => { const d = mkdtempSync(join(tmpdir(), 'panels-')); dirs.push(d); return join(d, 'panels') }
const writerA = 'a1'.repeat(8)
const writerB = 'b2'.repeat(8)

// Whether another open file can take the lock now.
function free(path: string): boolean {
  const fd = openSync(path, 'r')
  try { return flock()!(fd, LOCK_EX | LOCK_NB) === 0 } finally { closeSync(fd) }
}

// Slots that are always free, and the edits a sweep made.
function slots(answer: () => Promise<void> = async () => {}) {
  const made: { chat: string; message: number; text: string }[] = []
  const s: SweepSlots = { now: Date.now, take: () => true, holdUntil: () => {}, edit: (chat, message, text) => { made.push({ chat, message, text }); return answer() } }
  return { s, made }
}
const settle = () => new Promise(r => setTimeout(r, 5))

describe.skipIf(process.platform !== 'linux')('the panel records', () => {
  test('a record holds the chat, the message, its closing text and its writer, and its writer holds its lock from the first record on', () => {
    const dir = folder()
    const store = createPanelStore({ dir, writer: writerA })
    expect(existsSync(dir)).toBe(false)
    store.write('1', 7, '🤖 Subagents\n1. 🔌 No longer followed after 5s · general-purpose · last: Starting…')
    expect(JSON.parse(readFileSync(join(dir, '1-7.json'), 'utf8'))).toEqual({
      chat: '1', message: 7, text: '🤖 Subagents\n1. 🔌 No longer followed after 5s · general-purpose · last: Starting…', writer: writerA,
    })
    expect(readdirSync(dir).sort()).toEqual(['1-7.json', `${writerA}.lock`])
    expect(free(join(dir, `${writerA}.lock`))).toBe(false)
    store.write('1', 7, 'newer')
    expect(JSON.parse(readFileSync(join(dir, '1-7.json'), 'utf8')).text).toBe('newer')
    store.remove('1', 7)
    expect(readdirSync(dir)).toEqual([`${writerA}.lock`])
  })

  test('a write that fails deletes its temporary file, and one that cannot start leaves the earlier record', () => {
    const dir = folder()
    const store = createPanelStore({ dir, writer: writerA })
    store.write('1', 7, 'first')
    // A rename over a folder fails after the temporary file was written.
    mkdirSync(join(dir, '1-8.json', 'x'), { recursive: true })
    store.write('1', 8, 'never')
    expect(readdirSync(dir).filter(n => n.endsWith('.tmp'))).toEqual([])
    chmodSync(dir, 0o500)
    store.write('1', 7, 'second')
    chmodSync(dir, 0o700)
    expect(JSON.parse(readFileSync(join(dir, '1-7.json'), 'utf8')).text).toBe('first')
  })

  test('where flock does not load, nothing is written', () => {
    const dir = folder()
    const store = createPanelStore({ dir, writer: writerA, flock: null })
    store.write('1', 7, 'text')
    expect(existsSync(dir)).toBe(false)
  })

  test('a sweep that tries between the writer\'s open and its flock leaves the writer locked on the file at its path, and its records stay', async () => {
    const dir = folder()
    const sweeper = createPanelStore({ dir, writer: writerB })
    const real = flock()!
    let raced = false
    const writer = createPanelStore({ dir, writer: writerA, flock: (fd, op) => {
      // The sweep's try lands right after the writer's first open.
      if (!raced) { raced = true; sweeper.sweep(slots().s) }
      return real(fd, op)
    } })
    writer.write('1', 7, 'kept')
    expect(raced).toBe(true)
    const lock = join(dir, `${writerA}.lock`)
    expect(existsSync(lock)).toBe(true)
    expect(free(lock)).toBe(false)
    const { s, made } = slots()
    sweeper.sweep(s)
    await settle()
    expect(made).toEqual([])
    expect(existsSync(join(dir, '1-7.json'))).toBe(true)
  })

  test('a sweep\'s try on a missing lock file creates nothing, and closes that writer\'s record', async () => {
    const dir = folder()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '1-9.json'), JSON.stringify({ chat: '1', message: 9, text: 'closed', writer: writerA }))
    let answer!: () => void
    const { s, made } = slots(() => new Promise<void>(r => { answer = r }))
    createPanelStore({ dir, writer: writerB }).sweep(s)
    await settle()
    // While Telegram has not answered, the sweep holds what it found, and
    // never a lock file of its own making.
    expect(made).toEqual([{ chat: '1', message: 9, text: 'closed' }])
    expect(readdirSync(dir)).toEqual(['1-9.json'])
    answer()
    await settle()
    expect(readdirSync(dir)).toEqual([])
  })

  test('a swept record survives only a 429, a 5xx or a network failure, and its writer\'s lock file goes with its last record', async () => {
    const dir = folder()
    mkdirSync(dir, { recursive: true })
    const answers: Record<number, unknown> = {
      1: { error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } },
      2: { error_code: 502, description: 'Bad Gateway' },
      3: Object.assign(new Error('Network request failed'), { name: 'HttpError' }),
      4: { error_code: 400, description: 'Bad Request: message to edit not found' },
      5: { error_code: 400, description: 'Bad Request: message is not modified' },
      6: { error_code: 400, description: 'Bad Request: message can\'t be edited' },
    }
    for (const m of Object.keys(answers)) writeFileSync(join(dir, `1-${m}.json`), JSON.stringify({ chat: '1', message: Number(m), text: `t${m}`, writer: writerA }))
    writeFileSync(join(dir, `${writerA}.lock`), '')
    let held = 0
    const holds: number[] = []
    const s: SweepSlots = { now: () => 1000, take: () => true, holdUntil: (_c, t) => { held = t; holds.push(t) },
      edit: async (_c, message) => { if (answers[message]) throw answers[message] } }
    const store = createPanelStore({ dir, writer: writerB })
    store.sweep(s)
    await settle()
    expect(readdirSync(dir).sort()).toEqual(['1-1.json', '1-2.json', '1-3.json', `${writerA}.lock`])
    expect(held).toBe(4000)
    expect(holds).toHaveLength(1)
    for (const m of [1, 2, 3]) delete answers[m]
    store.sweep(s)
    await settle()
    expect(readdirSync(dir)).toEqual([])
  })
})
