// Messages a sender sends in quick succession reach Claude as one, as in
// OpenClaw: a burst of short texts, a long paste Telegram split into
// 4096-character pieces, and photos and documents, an album's or a file sent
// with its question. Claude then answers the burst once, not its first message
// alone.
//
// A batch goes out a gap after its last message, as soon as it is full, and
// at the latest MAX_WAIT_MS after its first. Anything else from the sender (a
// voice note, audio, a video, a sticker, or a person's command) sends the
// batch first, then goes alone. A message from someone else in the chat, or
// one replying to another message than the batch's, also sends it first, so
// the chat keeps its order and each message its reply.

import type { DoneSeed } from './arrivals.ts'

export const TEXT_GAP_MS = 300
// A piece near Telegram's 4096 limit is likely followed by the rest of a paste.
export const FRAGMENT_GAP_MS = 1500
export const FRAGMENT_CHARS = 4000
export const PHOTO_GAP_MS = 500
// Another bot on this plugin sends a reply's files first and its text right
// after them (see bots.ts), so its file waits for one text send.
export const BOT_FILE_GAP_MS = 3000
export const MAX_WAIT_MS = 7500
export const MAX_MESSAGES = 12
export const MAX_CHARS = 50_000

// A message on its way to Claude. done carries what each update's done line
// in the record says (see arrivals.ts); it never reaches Claude.
export type Inbound = { content: string; meta: Record<string, string>; done?: DoneSeed[] }

const REPLY_KEYS = ['reply_to_message_id', 'reply_to_user', 'reply_to_text', 'reply_to_kind', 'reply_quote']
const ATTACHMENT_KEYS = ['attachment_kind', 'attachment_file_id', 'attachment_size', 'attachment_mime', 'attachment_name']

// One message for a batch: the texts, captions and file labels in order,
// joined by a line break, or by nothing after a piece of a split paste. It
// carries the last message's id and time, every id in message_ids, the first
// reply context, and every photo in image_paths, the first also in image_path.
// Its attachment_* keys are the first file's; with two or more files, every
// file's id is in attachment_file_ids and every file's name, empty where
// Telegram gives none, in attachment_names, both in message order.
export function mergeInbound(items: Inbound[]): Inbound {
  if (items.length === 1) return items[0]!
  let content = ''
  items.forEach((item, i) => {
    if (i > 0) content += items[i - 1]!.content.length >= FRAGMENT_CHARS ? '' : '\n'
    content += item.content
  })
  const meta: Record<string, string> = { ...items.at(-1)!.meta }
  for (const k of REPLY_KEYS) delete meta[k]
  const replied = items.find(item => item.meta.reply_to_message_id || item.meta.reply_quote)
  if (replied) for (const k of REPLY_KEYS) if (replied.meta[k] !== undefined) meta[k] = replied.meta[k]
  meta.message_ids = items.map(item => item.meta.message_id).filter(Boolean).join(',')
  const images = items.map(item => item.meta.image_path).filter(Boolean)
  delete meta.image_path
  if (images.length > 0) meta.image_path = images[0]!
  if (images.length > 1) meta.image_paths = images.join(',')
  for (const k of ATTACHMENT_KEYS) delete meta[k]
  const files = items.filter(item => item.meta.attachment_file_id)
  if (files.length > 0) for (const k of ATTACHMENT_KEYS) if (files[0]!.meta[k] !== undefined) meta[k] = files[0]!.meta[k]
  if (files.length > 1) {
    meta.attachment_file_ids = files.map(item => item.meta.attachment_file_id).join(',')
    // The lists are comma-separated, so a comma in a name becomes _.
    meta.attachment_names = files.map(item => (item.meta.attachment_name ?? '').replace(/,/g, '_')).join(',')
  }
  const done = items.flatMap(item => item.done ?? [])
  return done.length > 0 ? { content, meta, done } : { content, meta }
}

// The gap a message joins its sender's batch with: a file's (a photo or a
// document, a photo that failed to download included), longer from another
// bot; plain text's, longer after a piece near the limit; or none for
// anything else, such as a voice note, a video or a person's command. A
// bot's text starting with / joins like any text, so a reply that opens with
// a path stays with its files.
export function batchGap(m: { text: string; file: boolean; other: boolean; bot: boolean }): number | undefined {
  if (m.file) return m.bot ? BOT_FILE_GAP_MS : PHOTO_GAP_MS
  if (m.other || (!m.bot && m.text.startsWith('/'))) return undefined
  return m.text.length >= FRAGMENT_CHARS ? FRAGMENT_GAP_MS : TEXT_GAP_MS
}

type Pending = { chat: string; items: Inbound[]; chars: number; first: number; timer?: unknown }

const replyOf = (item: Inbound) => item.meta.reply_to_message_id ?? item.meta.reply_quote

export function createBatcher(opts: {
  // May return a promise, which flushAll waits for.
  deliver: (item: Inbound) => unknown
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  // A lane step's error, which never stops the sender's later steps.
  onError?: (err: unknown) => void
}) {
  const now = opts.now ?? Date.now
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>))
  const pending = new Map<string, Pending>()
  // Set once the server stops: from then on a message goes out at once, and a
  // lane hands nothing on.
  let closing = false
  const onError = opts.onError ?? (err => process.stderr.write(`telegram channel: a message's step failed: ${err}\n`))
  // Each sender's lane: the tail of the chain of its messages' steps.
  const lanes = new Map<string, Promise<void>>()
  const settle = (key: string, tail: Promise<void>) => {
    lanes.set(key, tail)
    void tail.finally(() => {
      // Only the tail that finished: a later step may already wait behind it.
      if (lanes.get(key) === tail) lanes.delete(key)
    })
  }

  const flush = (key: string) => {
    const p = pending.get(key)
    if (!p) return
    pending.delete(key)
    clearTimer(p.timer)
    // A batch can go out from a timer, where a throw would end the server.
    try {
      return opts.deliver(mergeInbound(p.items))
    } catch (err) {
      process.stderr.write(`telegram channel: failed to deliver inbound batch: ${err}\n`)
    }
  }
  // Batches of the chat's other senders go first.
  const flushOthers = (key: string, chat: string) => {
    for (const [k, p] of [...pending]) if (k !== key && p.chat === chat) flush(k)
  }
  const arm = (key: string, p: Pending, gapMs: number) => {
    clearTimer(p.timer)
    p.timer = setTimer(() => flush(key), Math.max(0, Math.min(gapMs, p.first + MAX_WAIT_MS - now())))
  }

  const add = (key: string, chat: string, item: Inbound, gapMs: number) => {
    if (closing) {
      flush(key)
      opts.deliver(item)
      return
    }
    flushOthers(key, chat)
    let p = pending.get(key)
    const reply = replyOf(item)
    if (p && (p.chars + item.content.length > MAX_CHARS || (reply && p.items.some(i => replyOf(i) && replyOf(i) !== reply)))) {
      flush(key)
      p = undefined
    }
    if (!p) {
      p = { chat, items: [], chars: 0, first: now() }
      pending.set(key, p)
    }
    p.items.push(item)
    p.chars += item.content.length
    if (p.items.length >= MAX_MESSAGES) flush(key)
    else arm(key, p, gapMs)
  }

  return {
    // Adds an item to the sender's batch, which goes out gapMs after it.
    add,
    // Runs a step once every step the sender's earlier messages started has
    // handed its message on, so a sender's messages reach the batcher in the
    // order they came. A sender with no step waiting has an idle lane, and the
    // step runs before inOrder returns, so a plain text batches at once. A
    // step that throws is reported, and the sender's next step still runs.
    inOrder(key: string, step: () => unknown) {
      const prev = lanes.get(key)
      if (prev) {
        settle(key, prev.then(step).then(() => {}).catch(onError))
        return
      }
      let result: unknown
      try {
        result = step()
      } catch (err) {
        onError(err)
        return
      }
      if (result instanceof Promise) settle(key, result.then(() => {}).catch(onError))
    },
    // Hands a lane's message on, in one step with nothing awaited: into the
    // sender's batch with gapMs, or alone after the sender's batch with none,
    // after every batch of the chat with chatFirst. Once the server stops it
    // hands nothing on and returns false: the next server replays the message.
    handOn(key: string, chat: string, item: Inbound, gapMs: number | undefined, chatFirst = false): boolean {
      if (closing) return false
      if (chatFirst) for (const [k, p] of [...pending]) if (p.chat === chat) flush(k)
      if (gapMs === undefined) {
        flush(key)
        opts.deliver(item)
      } else add(key, chat, item, gapMs)
      return true
    },
    // A message from the sender is being prepared (a photo downloading): the
    // batch waits for it, up to MAX_WAIT_MS after its first item. The chat's
    // other senders' batches go now.
    hold(key: string, chat: string) {
      flushOthers(key, chat)
      const p = pending.get(key)
      if (p) arm(key, p, MAX_WAIT_MS)
    },
    // Sends the sender's batch now, and then item, if any, on its own.
    flush(key: string, item?: Inbound) {
      flush(key)
      if (item) opts.deliver(item)
    },
    // Every batch of the chat, now: a permission answer must not overtake
    // text sent before it.
    flushChat(chat: string) {
      for (const [k, p] of [...pending]) if (p.chat === chat) flush(k)
    },
    // Every waiting batch, now, and every later message at once: the server
    // is stopping, and Telegram counts the updates as delivered.
    flushAll(): Promise<unknown> {
      closing = true
      return Promise.allSettled([...pending.keys()].map(k => flush(k)))
    },
  }
}
