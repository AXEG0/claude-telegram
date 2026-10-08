// Messages a sender sends in quick succession reach Claude as one, as in
// OpenClaw: a burst of short texts, a long paste Telegram split into
// 4096-character pieces, and photos, an album's or a photo sent with its
// question. Claude then answers the burst once, not its first message alone.
//
// A batch goes out a gap after its last message, sooner if it is full, and at
// the latest MAX_WAIT_MS after its first. Anything else from the sender (a
// document, a voice note, a command) sends the batch first, then goes alone.

export const TEXT_GAP_MS = 300
// A piece near Telegram's 4096 limit is likely followed by the rest of a paste.
export const FRAGMENT_GAP_MS = 1500
export const FRAGMENT_CHARS = 4000
export const PHOTO_GAP_MS = 500
export const MAX_WAIT_MS = 7500
export const MAX_MESSAGES = 12
export const MAX_CHARS = 50_000

export type Inbound = { content: string; meta: Record<string, string> }

const REPLY_KEYS = ['reply_to_message_id', 'reply_to_user', 'reply_to_text', 'reply_to_kind', 'reply_quote']

// One message for a batch: the texts in order, joined by a line break, or by
// nothing after a piece of a split paste. It carries the last message's id and
// time, every id in message_ids, the first reply context, and every photo in
// image_paths, the first also in image_path.
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
  return { content, meta }
}

// The gap a message joins its sender's batch with: a photo's, plain text's
// (longer after a piece near the limit), or none for anything else, such as a
// document, a voice note, a photo that failed to download, or a command.
export function batchGap(m: { text: string; photo: boolean; other: boolean }): number | undefined {
  if (m.photo) return PHOTO_GAP_MS
  if (m.other || m.text.startsWith('/')) return undefined
  return m.text.length >= FRAGMENT_CHARS ? FRAGMENT_GAP_MS : TEXT_GAP_MS
}

type Pending = { items: Inbound[]; chars: number; first: number; timer?: unknown }

export function createBatcher(opts: {
  deliver: (item: Inbound) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}) {
  const now = opts.now ?? Date.now
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>))
  const pending = new Map<string, Pending>()

  const flush = (key: string) => {
    const p = pending.get(key)
    if (!p) return
    pending.delete(key)
    clearTimer(p.timer)
    // A batch can go out from a timer, where a throw would end the server.
    try {
      opts.deliver(mergeInbound(p.items))
    } catch (err) {
      process.stderr.write(`telegram channel: failed to deliver inbound batch: ${err}\n`)
    }
  }
  const arm = (key: string, p: Pending, gapMs: number) => {
    clearTimer(p.timer)
    p.timer = setTimer(() => flush(key), Math.max(0, Math.min(gapMs, p.first + MAX_WAIT_MS - now())))
  }

  return {
    // Adds an item to the sender's batch, which goes out gapMs after it.
    add(key: string, item: Inbound, gapMs: number) {
      let p = pending.get(key)
      if (p && (p.items.length >= MAX_MESSAGES || p.chars + item.content.length > MAX_CHARS)) {
        flush(key)
        p = undefined
      }
      if (!p) {
        p = { items: [], chars: 0, first: now() }
        pending.set(key, p)
      }
      p.items.push(item)
      p.chars += item.content.length
      arm(key, p, gapMs)
    },
    // A message from the sender is being prepared (a photo downloading): the
    // batch waits for it, up to MAX_WAIT_MS after its first item.
    hold(key: string) {
      const p = pending.get(key)
      if (p) arm(key, p, MAX_WAIT_MS)
    },
    // Sends the sender's batch now, and then item, if any, on its own.
    flush(key: string, item?: Inbound) {
      flush(key)
      if (item) opts.deliver(item)
    },
  }
}
