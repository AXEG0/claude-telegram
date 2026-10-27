// The record of each open subagents message, kept in <state dir>/panels/, so
// the next server that polls the bot closes a message whose own server died
// before its closing edit went out: killed with SIGKILL, a power loss, a
// closing edit refused with a 429 or failed on a 5xx or the network, or the
// exit's time limit. See agents.ts for when the stream writes and deletes one.
//
// - <chat>-<message id>.json holds { chat, message, text, writer }: the text
//   the message should read once its writer is gone. It is written to
//   <record>.<writer id>.tmp first and renamed over the record, so a reader
//   sees the old record or the new one, never half of one.
// - <writer id>.lock is the writer's lock, taken right before its first
//   record and held for the rest of its life. The kernel releases a flock
//   however its holder dies, so a lock another process can take means its
//   writer is gone. Only a sweep that holds that lock deletes the file, never
//   the writer itself, a clean exit included.
//
// The server that polls the bot sweeps on each tick: for each other writer
// named by a record, a temporary file or a lock file, it tries that writer's
// lock once. A writer that is gone gets each of its messages edited to the
// stored text at the chat's next slot, then its records deleted, then its lock
// file, before the sweep lets go of the lock.

import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { flock as libcFlock, LOCK_EX, LOCK_NB } from './buttons.ts'
import type { PanelRecords, SweepSlots } from './agents.ts'

export type Flock = (fd: number, op: number) => number

export type PanelStore = PanelRecords & {
  // This server's writer id.
  writer: string
  sweep(slots: SweepSlots): void
}

type Stored = { file: string; chat: string; message: number; text: string; writer: string }

const WRITER = /^[0-9a-f]{16}$/

export function createPanelStore(opts: {
  dir: string
  // flock(2); by default the C library's, and none where it does not load,
  // which leaves the store writing nothing, as buttons are refused there.
  flock?: Flock | null
  writer?: string
}): PanelStore {
  const dir = opts.dir
  const f = opts.flock === null ? undefined : opts.flock ?? libcFlock()
  const writer = opts.writer ?? randomBytes(8).toString('hex')
  const lockPath = (id: string) => join(dir, `${id}.lock`)
  const recordPath = (chat: string, message: number) => join(dir, `${chat}-${message}.json`)
  let lockFd: number | undefined
  let noLock = false

  // The writer's lock: an open, then a flock. A sweep that tries between the
  // two can take the lock, find no record and delete the file, leaving this
  // writer locked on a file no longer at its path; so once locked, the open
  // file must still be the one at the path, or the lock is taken again.
  function ensureLock(): boolean {
    if (lockFd !== undefined) return true
    if (noLock || !f) return false
    noLock = true
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      for (let attempt = 0; attempt < 5; attempt++) {
        const path = lockPath(writer)
        const fd = openSync(path, 'a', 0o600)
        if (f(fd, LOCK_EX) !== 0) { closeSync(fd); return false }
        const held = fstatSync(fd)
        let at: ReturnType<typeof statSync> | undefined
        try { at = statSync(path) } catch {}
        if (at && held.nlink > 0 && held.ino === at.ino && held.dev === at.dev) {
          lockFd = fd
          noLock = false
          return true
        }
        closeSync(fd)
      }
    } catch {}
    return false
  }

  function write(chat: string, message: number, text: string): void {
    if (!/^-?\d+$/.test(chat) || !Number.isInteger(message) || !ensureLock()) return
    const file = recordPath(chat, message)
    const tmp = `${file}.${writer}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify({ chat, message, text, writer }), { mode: 0o600 })
      renameSync(tmp, file)
    } catch {
      // A failed write, a full disk say, leaves the earlier record.
      try { rmSync(tmp, { force: true }) } catch {}
    }
  }

  function remove(chat: string, message: number): void {
    if (lockFd === undefined) return
    try { rmSync(recordPath(chat, message), { force: true }) } catch {}
  }

  // The sweep's state across ticks: the locks of writers that are gone, held
  // while any of their records remains, and the records being edited.
  const held = new Map<string, number>()
  const editing = new Set<string>()
  let pending = new Map<string, Set<string>>()

  // Whether a writer is gone: its lock file is missing, or its lock can be
  // taken. The try opens the file without creating it, and a lock this sweep
  // already holds is reused, since a fresh open and flock in this process
  // would be refused by its own lock and read as alive.
  function gone(id: string): boolean {
    if (held.has(id)) return true
    let fd: number
    try {
      fd = openSync(lockPath(id), 'r')
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT'
    }
    if (f!(fd, LOCK_EX | LOCK_NB) === 0) {
      held.set(id, fd)
      return true
    }
    closeSync(fd)
    return false
  }

  // A writer that is gone and has no record left loses its lock file, in the
  // same pass as its last record and before the lock is let go, so whoever
  // waits on that lock finds the file deleted once the sweep has closed the
  // last message.
  function finish(id: string): void {
    if ((pending.get(id)?.size ?? 0) > 0) return
    const fd = held.get(id)
    if (fd === undefined) return
    try { rmSync(lockPath(id), { force: true }) } catch {}
    closeSync(fd)
    held.delete(id)
  }

  function drop(r: Stored): void {
    try { rmSync(r.file, { force: true }) } catch {}
    pending.get(r.writer)?.delete(r.file)
  }

  // One swept message: a record survives only an answer worth retrying, a 429
  // (the chat then waits its retry_after), a 5xx or a network failure. "Not
  // modified" counts as done, and any other answer, the message gone or no
  // longer editable among them, deletes the record.
  function close(r: Stored, slots: SweepSlots): void {
    if (editing.has(r.file) || !slots.take(r.chat)) return
    editing.add(r.file)
    void Promise.resolve().then(() => slots.edit(r.chat, r.message, r.text)).then(() => drop(r), (err: unknown) => {
      const e = (err ?? {}) as { description?: unknown; error_code?: unknown; name?: unknown; parameters?: { retry_after?: unknown } }
      if (/message is not modified/i.test(String(e.description ?? err))) return drop(r)
      const retry = e.parameters?.retry_after
      if (typeof retry === 'number') return slots.holdUntil(r.chat, slots.now() + retry * 1000)
      if ((typeof e.error_code === 'number' && e.error_code >= 500) || e.name === 'HttpError') return
      drop(r)
    }).finally(() => {
      editing.delete(r.file)
      finish(r.writer)
    })
  }

  function sweep(slots: SweepSlots): void {
    if (!f) return
    let names: string[]
    try { names = readdirSync(dir) } catch { return }
    const ids = new Set<string>()
    const temps = new Map<string, string[]>()
    const records = new Map<string, Stored[]>()
    for (const name of names) {
      const file = join(dir, name)
      const lock = /^([0-9a-f]{16})\.lock$/.exec(name)
      const tmp = /\.([0-9a-f]{16})\.tmp$/.exec(name)
      if (lock) ids.add(lock[1]!)
      else if (tmp) {
        ids.add(tmp[1]!)
        temps.set(tmp[1]!, [...temps.get(tmp[1]!) ?? [], file])
      } else if (name.endsWith('.json')) {
        let r: Partial<Stored> | undefined
        try {
          r = JSON.parse(readFileSync(file, 'utf8'))
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
        }
        // The rename rules out a half-written record, so one that does not
        // parse is damaged and goes.
        if (!r || typeof r.chat !== 'string' || !/^-?\d+$/.test(r.chat) || !Number.isInteger(r.message)
          || typeof r.text !== 'string' || typeof r.writer !== 'string' || !WRITER.test(r.writer)) {
          try { rmSync(file, { force: true }) } catch {}
          continue
        }
        ids.add(r.writer)
        records.set(r.writer, [...records.get(r.writer) ?? [], { ...r, file } as Stored])
      }
    }
    pending = new Map([...records].map(([id, list]) => [id, new Set(list.map(r => r.file))]))
    for (const id of ids) {
      if (id === writer || !gone(id)) continue
      // A temporary file whose writer is gone is never renamed.
      for (const tmp of temps.get(id) ?? []) try { rmSync(tmp, { force: true }) } catch {}
      for (const r of records.get(id) ?? []) close(r, slots)
      if (![...editing].some(file => pending.get(id)?.has(file))) finish(id)
    }
  }

  return { writer, write, remove, sweep }
}
