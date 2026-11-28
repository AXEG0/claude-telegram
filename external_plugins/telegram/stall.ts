// What the session hears once Telegram answers again after leaving its sends
// unanswered. Telegram's Bot API can stop answering one bot for minutes to an
// hour, its sends ending with a 5xx or no answer at all, while every other bot
// works; a send whose outcome is unknown may still have landed, and nothing
// tells the session when Telegram answers again. Here the polling server keeps
// a record of the session's own replies and edits whose outcome is unknown
// (outcome.ts), opened by the first of them and joined by the rest, and closes
// it once Telegram answers a write begun after the last of them ended. At the
// close, one channel event goes to the session naming each of them and what to
// do: send again what still matters, marked as a possible repeat.
//
// A write is a call that sends or changes something: a send, an edit, a typing
// call, a reaction, a press's answer, or the probe below. Telegram answers it
// with ok, or with a refusal of its own (a 4xx); a 5xx or no answer is no
// answer. Polls and reads (getUpdates, getMe, getFile, getChat,
// getChatMember) never open, hold or close the record: polls have come back
// while sends still failed, and a reply to another bot reads that bot before
// it sends. The record transformer sees every call settle (flood.ts), and a
// write's start is its settle time less how long it took.
//
// While the record is open, or the subagents message's first send waits for
// Telegram to answer (after), the server calls the probe a minute after that
// began and a minute after each probe settles, so a session that writes
// nothing still gets its event. The probe is no proof that sends land: a send
// that fails after it closed the record opens a new one.
//
// Everything lives in the server's memory: a restart loses the record. The
// entries go once the event's notification resolves, which says only that the
// pipe to Claude Code took it; the close line then goes to the server log.
//
// This file carries no dependencies beyond Node's.

// How long after the record opens, or a first send begins to wait, and after
// each probe settles, the next probe goes.
export const PROBE_MS = 60_000

// The event's attribute, which only the plugin sets.
export const STALL_EVENT = 'telegram_stall'

// A reply or edit_message call whose outcome is unknown.
export type Entry = {
  tool: 'reply' | 'edit_message'
  // The chat_id the call passed.
  chat: string
  // For a reply to another bot, the @username it went to.
  bot?: string
  // When the call began and when its handler named its outcome unknown, in
  // milliseconds since the epoch.
  began: number
  ended: number
  // A reply's opening words.
  words?: string
  // A text_files call's saved copy, as the server log's line for the call
  // names it.
  copy?: string
  // A reply of several parts: the part it stopped at, of how many, and the
  // parts never tried.
  part?: number
  total?: number
  never?: string
  // The part whose outcome is unknown carried the reply's buttons, which are
  // kept.
  card?: boolean
  // The message an edit changed.
  message?: number
}

// One call as the record transformer saw it settle: its method, how long it
// took, and Telegram's answer (ok true or false, with its code), or null when
// no answer came.
export type Settled = { call: string; ms: number; ok: boolean | null; error_code?: number }

const WRITES = new Set(['setMessageReaction', 'answerCallbackQuery', 'setMyCommands'])

// Whether a method sends or changes something.
export function isWrite(method: string): boolean {
  return /^(send|edit)[A-Z]/.test(method) || WRITES.has(method)
}

// Whether Telegram answered the call: ok, or a refusal below 500.
export function isAnswer(s: Settled): boolean {
  return s.ok === true || (s.ok === false && typeof s.error_code === 'number' && s.error_code < 500)
}

const iso = (t: number) => new Date(t).toISOString()

// An entry as the event names it.
export function entryText(e: Entry): string {
  if (e.tool === 'edit_message') return `chat ${e.chat}, message ${e.message}, began ${iso(e.began)}`
  const parts = [`chat ${e.chat}`]
  if (e.bot) parts.push(e.bot)
  parts.push(`began ${iso(e.began)}`)
  if (e.words !== undefined) parts.push(JSON.stringify(e.words))
  if (e.copy) parts.push(`saved copy ${e.copy}`)
  if (e.total !== undefined && e.total > 1) parts.push(`part ${e.part} of ${e.total}, parts never tried: ${e.never}`)
  return parts.join(', ')
}

// The event's text for the entries of a record open from since until until.
export function eventText(entries: Entry[], since: number, until: number): string {
  const edits = entries.filter(e => e.tool === 'edit_message')
  const replies = entries.filter(e => e.tool === 'reply')
  const bots = replies.filter(e => e.bot)
  const cards = replies.filter(e => !e.bot && e.card)
  const people = replies.filter(e => !e.bot && !e.card)
  const list = (es: Entry[]) => es.map(entryText).join('; ')
  const lines = [
    `Telegram left these sends of this bot unanswered from ${iso(since)} and answered a write begun after them at ${iso(until)}. ` +
    "Telegram says it keeps a bot's updates up to 24 hours and gives no sign when a message it held will come, so messages sent to this bot in the 24 hours before this note may still arrive, each with its own send time; " +
    `${iso(until)} is when Telegram answered this bot's writes again, not when messages to it stopped waiting.`,
  ]
  if (people.length) lines.push(`To people, delivery unknown: ${list(people)}. Send again what still matters, its first line saying it may repeat an earlier message; for what went stale, send a short note that it replaces any earlier copy.`)
  if (bots.length) lines.push(`To bots, delivery unknown: ${list(bots)}. Ask that bot whether it arrived, and send it again only if it says no.`)
  if (cards.length) lines.push(`Cards, delivery unknown: ${list(cards)}. Its buttons still count if it arrived. If a press on it has reached you, there is nothing to send. Otherwise, if it went stale, send a short note that it replaces any earlier copy; if it still matters, send its text again without buttons, its first line saying it may repeat an earlier message, and ask for the answer in words or on the earlier copy's buttons. If its reader says the earlier copy never came, send it again with buttons, as today.`)
  if (edits.length) lines.push(`Edits, outcome unknown: ${list(edits)}. Repeat each as it stands.`)
  return lines.join('\n')
}

// An entry as the server log's lines carry it.
const logged = (e: Entry) => ({ ...e, began: iso(e.began), ended: iso(e.ended), line: entryText(e) })

export type Stall = {
  // A reply or edit whose outcome is unknown: opens the record, or joins it.
  // Returns the record's since, the earliest start among its entries.
  unknown(entry: Entry): number
  // A call the record transformer saw settle at at.
  settled(s: Settled, at: number): void
  // Settles once Telegram answers a write begun after ended, for a first send
  // of the subagents message whose outcome is unknown.
  after(ended: number): Promise<void>
  // Stops the probe, as at shutdown.
  stop(): void
}

export function createStall(opts: {
  // The event, handed to Claude Code; resolves once the pipe took it.
  notify: (content: string, meta: Record<string, string>) => Promise<unknown>
  // The probe: a write that shows no one anything.
  probe: () => Promise<unknown>
  // A line for the server log.
  log: (line: string) => void
  probeMs?: number
}): Stall {
  const probeMs = opts.probeMs ?? PROBE_MS
  // The open record: its entries, since, and the latest end among them.
  let record: { entries: Entry[]; since: number; last: number } | undefined
  // The first sends waiting for an answered write begun after each ended.
  const waits: { ended: number; resolve: () => void }[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let probing = false
  let stopped = false

  const needed = () => !stopped && (record !== undefined || waits.length > 0)
  function schedule(): void {
    if (timer !== undefined || probing || !needed()) return
    timer = setTimeout(fire, probeMs)
    timer.unref?.()
  }
  function fire(): void {
    timer = undefined
    if (!needed()) return
    probing = true
    let call: Promise<unknown>
    try { call = Promise.resolve(opts.probe()) } catch (err) { call = Promise.reject(err) }
    void call.catch(() => {}).finally(() => {
      probing = false
      schedule()
    })
  }
  function idle(): void {
    if (needed() || timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  function close(s: Settled, at: number): void {
    const r = record!
    record = undefined
    const probe = s.call === 'setMyCommands' && probing
    const meta = { event: STALL_EVENT, since: iso(r.since), until: iso(at) }
    let handed: Promise<unknown>
    try { handed = Promise.resolve(opts.notify(eventText(r.entries, r.since, at), meta)) } catch (err) { handed = Promise.reject(err) }
    const line = { since: meta.since, until: meta.until, closed_by: s.call, probe, entries: r.entries.map(logged) }
    void handed.then(
      () => opts.log(`stall closed: ${JSON.stringify(line)}`),
      err => opts.log(`stall event not handed to Claude (${err instanceof Error ? err.message : String(err)}): ${JSON.stringify(line)}`),
    )
  }

  return {
    unknown(entry) {
      if (record === undefined) {
        record = { entries: [entry], since: entry.began, last: entry.ended }
        opts.log(`stall opened: ${JSON.stringify({ since: iso(entry.began), by: logged(entry) })}`)
      } else {
        record.entries.push(entry)
        record.since = Math.min(record.since, entry.began)
        record.last = Math.max(record.last, entry.ended)
      }
      schedule()
      return record.since
    },
    settled(s, at) {
      if (!isWrite(s.call) || !isAnswer(s)) return
      const began = at - s.ms
      for (let i = waits.length - 1; i >= 0; i--) {
        if (began > waits[i]!.ended) waits.splice(i, 1)[0]!.resolve()
      }
      if (record !== undefined && began > record.last) close(s, at)
      idle()
    },
    after(ended) {
      return new Promise<void>(resolve => {
        waits.push({ ended, resolve })
        schedule()
      })
    },
    stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}
