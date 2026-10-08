// Telegram rich messages (Bot API 10.3): replies written in GitHub Markdown
// render with native headings, tables, task lists, code blocks, quotes and
// collapsible details. The server sends Telegram's own rich Markdown, through
// sendRichMessage and editMessageText, and falls back to plain text when
// Telegram rejects the content.
//
// On with TELEGRAM_RICH_MESSAGES=true in the environment or the channel's
// .env. Off by default, as some Telegram clients show rich messages as
// unsupported.

import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes, Parents, RootContent } from 'mdast'

// Telegram rejects more than 32768 characters or 500 blocks in a rich message
// and cuts its text past about 35000 UTF-8 bytes without an error, so a
// 32000-character Russian reply lost half. Parts stay inside both, counted in
// UTF-8 bytes of what is sent and in top-level blocks (list items and table
// rows do not count).
export const RICH_PART_BYTES = 30_000
export const RICH_PART_BLOCKS = 400

export function richEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.TELEGRAM_RICH_MESSAGES?.trim() ?? '')
}

export const RICH_INSTRUCTIONS =
  'Rich messages are on: reply and edit_message render GitHub Markdown as a Telegram rich message. ' +
  'Use headings, tables, lists and task lists (- [x]), quotes, fenced code and links; <details><summary>Title</summary>…</details> for a collapsible section; ' +
  '<u>, <sup>, <sub>, ==marked== and ||spoiler|| inline, so a literal == or || goes in backticks. Math only as <tg-math>…</tg-math> or a ```math block: a $ in text is sent as a literal dollar sign. ' +
  "Not MarkdownV2. Tables take only inline formatting in cells and at most 20 columns. Pass format: 'text' for a plain message."

export const RICH_FORMAT_HELP =
  "Rendering mode. 'rich' (the default) sends GitHub Markdown as a Telegram rich message (tables, headings, details). 'text' is plain, no escaping needed. 'markdownv2' enables Telegram formatting (bold, italic, code, links); caller must escape special chars per MarkdownV2 rules."

// The HTML tags a rich message renders (Bot API, Rich HTML style). Telegram
// drops any other tag and keeps its content, so "Vec<String>" arrived as
// "Vec". A name that is not HTML, such as a type parameter, goes out as &lt;;
// a lowercase HTML element such as <kbd> is left for Telegram to drop.
const RICH_TAGS = new Set([
  'a', 'aside', 'audio', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'del', 'details', 'em',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins',
  'li', 'mark', 'ol', 'p', 'pre', 's', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'video',
  'tg-button', 'tg-button-row', 'tg-collage', 'tg-document', 'tg-emoji', 'tg-map', 'tg-math',
  'tg-math-block', 'tg-reference', 'tg-slideshow', 'tg-spoiler', 'tg-thinking', 'tg-time',
])

const HTML_TAGS = new Set([
  'abbr', 'address', 'article', 'bdi', 'bdo', 'big', 'button', 'center', 'col', 'colgroup', 'data', 'dd',
  'dfn', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'font', 'form', 'header', 'iframe', 'kbd', 'label',
  'legend', 'main', 'meter', 'nav', 'object', 'option', 'progress', 'q', 'rp', 'rt', 'ruby', 'samp',
  'section', 'select', 'small', 'source', 'span', 'svg', 'textarea', 'time', 'tt', 'var', 'wbr',
])

// Containers whose html children are blocks; under any other parent html is inline.
const FLOW_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition'])

type Edit = { drop: number; insert: string }

function parse(md: string) {
  return fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
}

const startOf = (n: Nodes) => n.position?.start.offset ?? 0
const endOf = (n: Nodes) => n.position?.end.offset ?? 0

// What Telegram would misread in md, by source offset. A $ in text can open a
// formula ("path $HOME/$USER" became math), so it gets a backslash. Only text
// nodes are touched: in code, autolinks and link URLs the backslash would
// show. A tag Telegram does not render becomes &lt;.
function collectEdits(md: string, base: number, edits: Map<number, Edit>, root = parse(md)): void {
  const tag = (at: number) => {
    const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(md.slice(at, at + 64))?.[1]
    if (name && !RICH_TAGS.has(name.toLowerCase()) && !HTML_TAGS.has(name)) edits.set(base + at, { drop: 1, insert: '&lt;' })
  }
  const text = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      if (md[i] === '\\') i++
      else if (md[i] === '$') edits.set(base + i, { drop: 0, insert: '\\' })
    }
  }
  const walk = (node: Nodes, parent: Parents | undefined) => {
    switch (node.type) {
      case 'text':
        text(startOf(node), endOf(node))
        return
      case 'html':
        if (parent && !FLOW_PARENTS.has(parent.type)) tag(startOf(node))
        else if (/^\s*<details\b/i.test(node.value)) details(startOf(node), endOf(node))
        return
      case 'link':
        if (md[startOf(node)] === '<') return
        break
    }
    if (!('children' in node)) return
    for (const child of node.children as RootContent[]) walk(child, node as Parents)
  }
  // Telegram parses Markdown inside <details>, where CommonMark sees one HTML
  // block up to the first blank line: its first line is the summary, and the
  // rest is Markdown in its own right.
  const details = (from: number, to: number) => {
    const eol = md.indexOf('\n', from)
    const head = eol < 0 || eol > to ? to : eol
    for (let i = from; i < head; i++) {
      if (md[i] === '<') {
        tag(i)
        const close = md.indexOf('>', i)
        if (close >= 0 && close < head) i = close
      } else if (md[i] === '\\') i++
      else if (md[i] === '$') edits.set(base + i, { drop: 0, insert: '\\' })
    }
    if (head < to) collectEdits(md.slice(head, to), base + head, edits)
  }
  walk(root, undefined)
}

// The rich Markdown Telegram is sent for md, whole.
export function richMarkdown(md: string): string {
  return new Rendered(md).render(0, md.length)
}

class Rendered {
  readonly edits = new Map<number, Edit>()
  // bytes[i] is the UTF-8 size of what md[0, i) renders to.
  private readonly bytes: Uint32Array
  constructor(readonly md: string, root = parse(md)) {
    collectEdits(md, 0, this.edits, root)
    this.bytes = new Uint32Array(md.length + 1)
    for (let i = 0; i < md.length; i++) {
      const c = md.charCodeAt(i)
      let n = c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 ? 4 : c >= 0xdc00 && c < 0xe000 ? 0 : 3
      const e = this.edits.get(i)
      if (e) n = Buffer.byteLength(e.insert) + (e.drop ? 0 : n)
      this.bytes[i + 1] = this.bytes[i]! + n
    }
  }
  size(from: number, to: number): number {
    return this.bytes[to]! - this.bytes[from]!
  }
  render(from: number, to: number): string {
    let out = ''
    let at = from
    for (let i = from; i < to; i++) {
      const e = this.edits.get(i)
      if (!e) continue
      out += this.md.slice(at, i) + e.insert
      at = i + e.drop
    }
    return out + this.md.slice(at, to)
  }
}

// One message of a long reply: the rich Markdown, and the same text as written
// for a plain fallback.
export type RichPart = { rich: string; plain: string }

// Splits md into rich messages at top-level blocks, keeping a <details> section
// whole. A block too big alone is cut at lines; a code block is closed and
// reopened around each cut, and a table repeats its header.
export function richParts(md: string, limits = { bytes: RICH_PART_BYTES, blocks: RICH_PART_BLOCKS }): RichPart[] {
  const root = parse(md)
  const r = new Rendered(md, root)
  const units: { from: number; to: number; node: RootContent; count: number }[] = []
  let open = 0
  for (const node of root.children) {
    const last = units.at(-1)
    if (open > 0 && last) {
      last.to = endOf(node)
      last.count++
    } else units.push({ from: md.lastIndexOf('\n', startOf(node) - 1) + 1, to: endOf(node), node, count: 1 })
    if (node.type === 'html') open = Math.max(0, open + (node.value.match(/<details\b/gi)?.length ?? 0) - (node.value.match(/<\/details\s*>/gi)?.length ?? 0))
  }
  if (units.length === 0) return [{ rich: md, plain: md }]

  const parts: RichPart[] = []
  const range = (from: number, to: number) => ({ rich: r.render(from, to), plain: md.slice(from, to) })
  let cur: { from: number; to: number; count: number } | undefined
  const flush = () => {
    if (cur) parts.push(range(cur.from, cur.to))
    cur = undefined
  }
  for (const u of units) {
    if (cur && r.size(cur.from, u.to) <= limits.bytes && cur.count + u.count <= limits.blocks) {
      cur.to = u.to
      cur.count += u.count
      continue
    }
    flush()
    if (r.size(u.from, u.to) <= limits.bytes) cur = { from: u.from, to: u.to, count: u.count }
    else parts.push(...cutBlock(r, u.from, u.to, u.node, limits.bytes))
  }
  flush()
  return parts
}

function lines(md: string, from: number, to: number): [number, number][] {
  const out: [number, number][] = []
  for (let s = from; s <= to; ) {
    let e = md.indexOf('\n', s)
    if (e < 0 || e > to) e = to
    out.push([s, e])
    s = e + 1
  }
  return out
}

function cutBlock(r: Rendered, from: number, to: number, node: RootContent, limit: number): RichPart[] {
  const md = r.md
  let body = lines(md, from, to)
  let head: [number, number] | undefined
  let tail = ''
  const fence = node.type === 'code' ? /^ {0,3}(`{3,}|~{3,})/.exec(md.slice(from, to))?.[1] : undefined
  if (fence) {
    head = body.shift()
    const last = body.at(-1)
    if (last && md.slice(last[0], last[1]).trim().startsWith(fence)) body.pop()
    tail = fence
  } else if (node.type === 'table' && body.length > 2) {
    head = [body[0]![0], body[1]![1]]
    body = body.slice(2)
  }
  let headSize = head ? r.size(head[0], head[1]) + 1 : 0
  // A header too big to repeat is cut like any other line.
  if (head && headSize > limit / 2) {
    body = lines(md, from, to)
    head = undefined
    tail = ''
    headSize = 0
  }
  const room = Math.max(1, limit - headSize - (tail ? tail.length + 1 : 0))
  const range = (a: number, b: number) => ({ rich: r.render(a, b), plain: md.slice(a, b) })
  const wrap = (a: number, b: number): RichPart => {
    const pre = head ? range(head[0], head[1]) : undefined
    const mid = range(a, b)
    const join = (x: string | undefined, y: string) => (x === undefined ? y : `${x}\n${y}`)
    return {
      rich: join(pre?.rich, mid.rich) + (tail ? `\n${tail}` : ''),
      plain: join(pre?.plain, mid.plain) + (tail ? `\n${tail}` : ''),
    }
  }
  const out: RichPart[] = []
  let start: number | undefined
  let end = 0
  for (const [a, b] of body) {
    if (start !== undefined && r.size(start, b) <= room) {
      end = b
      continue
    }
    if (start !== undefined) out.push(wrap(start, end))
    start = a
    end = b
    // A line too long alone is cut by size. A low surrogate costs no bytes, so
    // the cut never lands inside a pair.
    while (r.size(start, end) > room) {
      let cut = start + 1
      while (cut < end && r.size(start, cut + 1) <= room) cut++
      out.push(wrap(start, cut))
      start = cut
    }
  }
  if (start !== undefined) out.push(wrap(start, end))
  return out
}

export type RawApi = {
  sendRichMessage(params: Record<string, unknown>): Promise<{ message_id: number }>
  sendMessage(params: Record<string, unknown>): Promise<{ message_id: number }>
  editMessageText(params: Record<string, unknown>): Promise<unknown>
}

// Whether a failed rich send or edit goes out plain instead: Telegram rejected
// the content (400, e.g. RICH_MESSAGE_MARKDOWN_INVALID) or the Bot API server
// has no rich messages (404). An unchanged edit, a rate limit or a network
// error is not a reason to.
export function plainFallback(err: unknown): boolean {
  const e = err as { error_code?: number; description?: string } | undefined
  if (e?.error_code === 404) return true
  return e?.error_code === 400 && !/message is not modified/i.test(e.description ?? '')
}

// Sends text as rich messages; a part Telegram rejects goes out plain, cut by
// plainChunks. Message ids land in progress.ids as they are sent, and
// progress.done counts finished parts of progress.total, so a failure part way
// reports what already went out.
export async function sendRich(opts: {
  raw: RawApi
  chatId: string
  text: string
  // The message to reply to for the nth message sent, if any.
  replyTo: (n: number) => number | undefined
  plainChunks: (text: string) => string[]
  progress: { ids: number[]; done: number; total: number }
}): Promise<void> {
  const { raw, chatId, progress } = opts
  const parts = richParts(opts.text)
  progress.total = parts.length
  const replyParams = () => {
    const to = opts.replyTo(progress.ids.length)
    return to != null ? { reply_parameters: { message_id: to, allow_sending_without_reply: true } } : {}
  }
  for (const part of parts) {
    try {
      const sent = await raw.sendRichMessage({ chat_id: chatId, rich_message: { markdown: part.rich }, ...replyParams() })
      progress.ids.push(sent.message_id)
    } catch (err) {
      if (!plainFallback(err)) throw err
      process.stderr.write(`telegram channel: rich message rejected, sending plain: ${describe(err)}\n`)
      for (const text of opts.plainChunks(part.plain)) {
        const sent = await raw.sendMessage({ chat_id: chatId, text, ...replyParams() })
        progress.ids.push(sent.message_id)
      }
    }
    progress.done++
  }
}

// Edits a message into rich text; if Telegram rejects the content, into plain.
export async function editRich(opts: { raw: RawApi; chatId: string; messageId: number; text: string }): Promise<void> {
  const parts = richParts(opts.text)
  if (parts.length > 1) throw new Error('text too long for one rich message: send it with reply instead')
  try {
    await opts.raw.editMessageText({ chat_id: opts.chatId, message_id: opts.messageId, rich_message: { markdown: parts[0]!.rich } })
  } catch (err) {
    if (!plainFallback(err)) throw err
    process.stderr.write(`telegram channel: rich edit rejected, editing plain: ${describe(err)}\n`)
    await opts.raw.editMessageText({ chat_id: opts.chatId, message_id: opts.messageId, text: opts.text })
  }
}

function describe(err: unknown): string {
  return String((err as { description?: string })?.description ?? (err instanceof Error ? err.message : err))
}
