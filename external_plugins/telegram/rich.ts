// Telegram rich messages (Bot API 10.3): replies written in GitHub Markdown
// render with native headings, tables, task lists, code blocks, quotes and
// collapsible details. The server sends Telegram's own rich Markdown, through
// sendRichMessage and editMessageText, and falls back to plain text when
// Telegram rejects the content.
//
// On with TELEGRAM_RICH_MESSAGES=true in the environment or the channel's
// .env. Off by default, as some Telegram clients show rich messages as
// unsupported.

export const RICH_LIMIT = 32768
const PLAIN_LIMIT = 4096

export function richEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.TELEGRAM_RICH_MESSAGES?.trim() ?? '')
}

export const RICH_INSTRUCTIONS =
  'Rich messages are on: reply and edit_message render GitHub Markdown as a Telegram rich message. ' +
  'Use headings, tables, lists and task lists (- [x]), quotes, fenced code and links; <details><summary>Title</summary>…</details> for a collapsible section; ' +
  '<u>, <sup>, <sub>, ==marked== and ||spoiler|| inline. Math only as <tg-math>…</tg-math> or a ```math block: every $ is sent as a literal dollar sign. ' +
  "Not MarkdownV2. Tables take only inline formatting in cells and at most 20 columns. Pass format: 'text' for a plain message."

// Rich Markdown reads $…$ as a formula, so "$400-600K and $5" became math.
// Every $ outside code is escaped; math has its own tags.
export function escapeDollars(md: string): string {
  const out: string[] = []
  let fence: string | undefined
  for (const line of md.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined
      out.push(line)
      continue
    }
    if (marker) {
      fence = marker
      out.push(line)
      continue
    }
    out.push(escapeLine(line))
  }
  return out.join('\n')
}

function escapeLine(line: string): string {
  let out = ''
  let i = 0
  while (i < line.length) {
    const ch = line[i]!
    if (ch === '`') {
      const run = /^`+/.exec(line.slice(i))![0]
      const close = line.indexOf(run, i + run.length)
      if (close >= 0) {
        out += line.slice(i, close + run.length)
        i = close + run.length
        continue
      }
      out += run
      i += run.length
      continue
    }
    if (line.startsWith('<tg-math', i)) {
      const end = line.indexOf('</tg-math', i)
      const stop = end >= 0 ? line.indexOf('>', end) : -1
      if (stop >= 0) {
        out += line.slice(i, stop + 1)
        i = stop + 1
        continue
      }
    }
    if (ch === '\\' && i + 1 < line.length) {
      out += line.slice(i, i + 2)
      i += 2
      continue
    }
    out += ch === '$' ? '\\$' : ch
    i++
  }
  return out
}

// Errors where Telegram rejects the rich content itself, after which the same
// text goes out plain. Anything else (rate limits, a missing chat) is rethrown.
export function isRichContentError(err: unknown): boolean {
  const desc = String((err as { description?: string })?.description ?? (err instanceof Error ? err.message : err))
  return /RICH_MESSAGE_|can't parse (InputRich|rich|entities)|RICH_[A-Z_]*INVALID/i.test(desc)
}

// The parts of a long text, cut at blank lines, then lines, then characters.
export function splitText(text: string, limit: number): string[] {
  const parts: string[] = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = window.lastIndexOf('\n\n')
    if (cut < limit / 2) cut = window.lastIndexOf('\n')
    if (cut < limit / 2) cut = limit
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) parts.push(rest)
  return parts
}

export type RawApi = {
  sendRichMessage(params: Record<string, unknown>): Promise<{ message_id: number }>
  sendMessage(params: Record<string, unknown>): Promise<{ message_id: number }>
  editMessageText(params: Record<string, unknown>): Promise<unknown>
}

// Sends text as rich messages; a part Telegram rejects goes out plain.
// Returns the sent message ids.
export async function sendRich(opts: {
  raw: RawApi
  chatId: string
  text: string
  // Reply parameters for the part at this index, if any.
  replyTo: (index: number) => number | undefined
}): Promise<number[]> {
  const ids: number[] = []
  const parts = splitText(opts.text, RICH_LIMIT)
  for (let i = 0; i < parts.length; i++) {
    const reply = opts.replyTo(i)
    const replyParams = reply != null ? { reply_parameters: { message_id: reply, allow_sending_without_reply: true } } : {}
    try {
      const sent = await opts.raw.sendRichMessage({
        chat_id: opts.chatId,
        rich_message: { markdown: escapeDollars(parts[i]!) },
        ...replyParams,
      })
      ids.push(sent.message_id)
    } catch (err) {
      if (!isRichContentError(err)) throw err
      process.stderr.write(`telegram channel: rich message rejected, sending plain: ${String((err as { description?: string }).description ?? err)}\n`)
      const plain = splitText(parts[i]!, PLAIN_LIMIT)
      for (let j = 0; j < plain.length; j++) {
        const sent = await opts.raw.sendMessage({ chat_id: opts.chatId, text: plain[j], ...(j === 0 ? replyParams : {}) })
        ids.push(sent.message_id)
      }
    }
  }
  return ids
}

// Edits a message into rich text; if Telegram rejects the content, into plain.
export async function editRich(opts: { raw: RawApi; chatId: string; messageId: number; text: string }): Promise<void> {
  try {
    await opts.raw.editMessageText({
      chat_id: opts.chatId,
      message_id: opts.messageId,
      rich_message: { markdown: escapeDollars(opts.text) },
    })
  } catch (err) {
    if (!isRichContentError(err)) throw err
    await opts.raw.editMessageText({ chat_id: opts.chatId, message_id: opts.messageId, text: opts.text.slice(0, PLAIN_LIMIT) })
  }
}
