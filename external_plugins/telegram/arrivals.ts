// The record of arrivals, arrivals.jsonl in the state folder: every message
// that has not yet reached Claude, kept across restarts, and each delivered
// message's step times and outcome, readable afterwards.
//
// - A start line holds the raw update, written for every admitted message
//   before its handler returns, so before the next poll confirms the update to
//   Telegram.
// - A done line holds the step times and the outcome or the reason, written
//   once the message has reached Claude: the notification's promise resolved,
//   so the pipe to Claude Code took the write.
// - A replayed line closes an entry the replay handed in when its handler
//   wrote nothing of its own, such as a sender no longer admitted.
//
// An entry whose newest line in the file is a start line is unfinished, and
// the next polling server replays it. Telegram keeps an update 24 hours, so an
// older entry is closed, not replayed, and only younger ids are skipped when a
// poll brings them again.
//
// Each append is synchronous, so an exit never drops one in flight, and starts
// on a fresh line, so a line cut short never swallows the next. Once an append
// leaves the file over the bound, the file is copied to arrivals.jsonl.1 and
// replaced, through a temp file and a rename, by each unfinished entry's newest
// start line, so it holds every unfinished start line at every moment. Every
// read and write catches its own failure: it goes to stderr, and the message
// carries on to Claude as if the record were not there.

import { appendFileSync, copyFileSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'

// The file's size past which an append compacts it.
export const ARRIVALS_BOUND = 1024 * 1024
// How long Telegram keeps an update: "they will not be kept longer than 24
// hours" (Bot API, Getting updates).
export const KEPT_MS = 24 * 60 * 60 * 1000
export const TOO_OLD = 'older than 24 h, the time Telegram keeps an update'

export type StartLine = {
  line: 'start'
  update_id: number
  // The message's own date, or an edit's edit_date, in epoch ms.
  sent: number
  // When the server got the update, in epoch ms.
  arrived: number
  // When the line was written.
  at: number
  update: unknown
}

// What a done line says about one message, carried with it to its delivery.
export type DoneSeed = {
  update_id: number
  chat_id: string
  message_id?: string
  kind: string
  size?: number
  arrived: number
  // Times in ms: waiting in the lane, and each file step that ran.
  queued: number
  getFile?: number
  download?: number
  transcribe?: number
  // When the lane handed the message to the batcher.
  handed: number
  outcome: string
  reason?: string
}

export type ArrivalsIo = {
  append: (file: string, data: string) => void
  read: (file: string) => string
  write: (file: string, data: string) => void
  rename: (from: string, to: string) => void
  copy: (from: string, to: string) => void
  size: (file: string) => number
}

const realIo: ArrivalsIo = {
  append: (file, data) => appendFileSync(file, data, { mode: 0o600 }),
  read: file => readFileSync(file, 'utf8'),
  write: (file, data) => writeFileSync(file, data, { mode: 0o600 }),
  rename: renameSync,
  copy: copyFileSync,
  size: file => statSync(file).size,
}

type Line = { line: 'start' | 'done' | 'replayed'; update_id: number; sent?: number; text: string; start?: StartLine }

const missing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT'

export function createArrivals(file: string, opts: {
  now?: () => number
  log?: (line: string) => void
  io?: Partial<ArrivalsIo>
  bound?: number
} = {}) {
  const io: ArrivalsIo = { ...realIo, ...opts.io }
  const now = opts.now ?? Date.now
  const log = opts.log ?? (line => process.stderr.write(`telegram channel: ${line}\n`))
  const bound = opts.bound ?? ARRIVALS_BOUND
  const old = `${file}.1`
  // Whether the file may not end in a line break, so the next append starts
  // with one: learnt from the file's last byte, or set by a failed append.
  let ragged = false
  // After a failed compaction, the size the file must reach before the next try.
  let retryAt = 0
  // Append calls for each update the replay is handing in, failed ones
  // included, counted in memory: a compaction can replace the file meanwhile.
  const counting = new Map<number, number>()

  function parse(text: string, name: string): Line[] {
    const out: Line[] = []
    text.split('\n').forEach((raw, i) => {
      if (!raw.trim()) return
      let rec: Record<string, unknown> | undefined
      try { rec = JSON.parse(raw) } catch {}
      const kind = rec?.line
      const ok = rec && typeof rec === 'object' && typeof rec.update_id === 'number'
        && (kind === 'done' || kind === 'replayed' || (kind === 'start' && typeof rec.sent === 'number'))
      if (!ok) {
        log(`${name} line ${i + 1} does not parse; skipped`)
        return
      }
      out.push({ line: kind as Line['line'], update_id: rec!.update_id as number, sent: rec!.sent as number | undefined, text: raw, start: kind === 'start' ? rec as StartLine : undefined })
    })
    return out
  }

  // Each update's newest line, in the order the updates first appear.
  function newest(lines: Line[]): Map<number, Line> {
    const out = new Map<number, Line>()
    for (const l of lines) out.set(l.update_id, l)
    return out
  }

  function compact(size: number): void {
    try {
      const lines = parse(io.read(file), 'arrivals.jsonl')
      io.copy(file, old)
      const kept = [...newest(lines).values()].filter(l => l.line === 'start')
      const tmp = `${file}.${process.pid}.tmp`
      io.write(tmp, kept.map(l => `${l.text}\n`).join(''))
      io.rename(tmp, file)
      ragged = false
      retryAt = 0
    } catch (err) {
      retryAt = size + bound
      log(`arrivals.jsonl not compacted: ${err}`)
    }
  }

  function append(rec: { line: Line['line']; update_id: number } & Record<string, unknown>): void {
    const n = counting.get(rec.update_id)
    if (n !== undefined) counting.set(rec.update_id, n + 1)
    try {
      io.append(file, `${ragged ? '\n' : ''}${JSON.stringify(rec)}\n`)
      ragged = false
    } catch (err) {
      ragged = true
      log(`arrivals.jsonl not written: ${err}`)
      return
    }
    let size: number
    try {
      size = io.size(file)
    } catch {
      return
    }
    if (size > bound && size >= retryAt) compact(size)
  }

  return {
    // The entries to replay, from the file alone: every update whose newest
    // line there is a start line. The ids to skip, from the file and from
    // arrivals.jsonl.1 alike: every update whose message is under 24 h old.
    open(): { replay: StartLine[]; skip: Set<number> } {
      let lines: Line[] = []
      try {
        const text = io.read(file)
        ragged = text.length > 0 && !text.endsWith('\n')
        lines = parse(text, 'arrivals.jsonl')
      } catch (err) {
        ragged = !missing(err)
        if (!missing(err)) log(`arrivals.jsonl not read: ${err}`)
      }
      let older: Line[] = []
      try {
        older = parse(io.read(old), 'arrivals.jsonl.1')
      } catch (err) {
        if (!missing(err)) log(`arrivals.jsonl.1 not read: ${err}`)
      }
      const t = now()
      const replay = [...newest(lines).values()]
        .filter(l => l.line === 'start')
        .map(l => l.start!)
        .sort((a, b) => a.update_id - b.update_id)
      const skip = new Set<number>()
      for (const l of [...older, ...lines]) if (l.line === 'start' && t - l.sent! < KEPT_MS) skip.add(l.update_id)
      return { replay, skip }
    },

    start(update: { update_id: number }, sent: number, arrived: number): void {
      append({ line: 'start', update_id: update.update_id, sent, arrived, at: now(), update })
    },

    done(seed: DoneSeed): void {
      const t = now()
      const { update_id, chat_id, message_id, kind, size, outcome, reason } = seed
      append({
        line: 'done', update_id, at: t, chat_id, message_id, kind, size,
        ms: {
          queued: seed.queued,
          ...(seed.getFile !== undefined ? { getFile: seed.getFile } : {}),
          ...(seed.download !== undefined ? { download: seed.download } : {}),
          ...(seed.transcribe !== undefined ? { transcribe: seed.transcribe } : {}),
          batched: t - seed.handed,
          total: t - seed.arrived,
        },
        outcome,
        ...(reason !== undefined ? { reason } : {}),
      })
    },

    // Hands each entry to the handler in update_id order. An entry over 24 h
    // old gets a done line and is not delivered; a handler that throws gets a
    // done line with the reason; one that wrote no line of its own for the
    // update gets a replayed line after it returns.
    async replay(entries: StartLine[], handle: (update: unknown, entry: StartLine) => Promise<unknown>): Promise<void> {
      for (const entry of entries) {
        const id = entry.update_id
        if (now() - entry.sent >= KEPT_MS) {
          append({ line: 'done', update_id: id, at: now(), outcome: 'not replayed', reason: TOO_OLD })
          continue
        }
        counting.set(id, 0)
        try {
          await handle(entry.update, entry)
        } catch (err) {
          counting.delete(id)
          append({ line: 'done', update_id: id, at: now(), outcome: 'not delivered', reason: `replay failed: ${err}` })
          continue
        }
        const wrote = counting.get(id)!
        counting.delete(id)
        if (wrote === 0) append({ line: 'replayed', update_id: id, at: now() })
      }
    },
  }
}
export type Arrivals = ReturnType<typeof createArrivals>
