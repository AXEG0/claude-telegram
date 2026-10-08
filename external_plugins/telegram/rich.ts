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
import type { Nodes, Parents, Root, RootContent } from 'mdast'

// Telegram rejects a rich message over 32768 characters, rejected one of 600
// paragraphs (the docs say 500 blocks; list items and table rows did not
// count), and cuts its text past about 35000 UTF-8 bytes without an error, so
// a 32000-character Russian reply lost half. Parts stay inside all three,
// counted in UTF-8 bytes of what is sent and in top-level blocks.
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
// A <details> or <summary> tag; open is +1 for <details>, -1 for </details>, 0 for summary.
type Tag = { from: number; to: number; open: number }

function parse(md: string): Root {
  return fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
}

const startOf = (n: Nodes) => n.position?.start.offset ?? 0
const endOf = (n: Nodes) => n.position?.end.offset ?? 0

// Telegram reads Markdown inside <details>, while CommonMark reads a line
// that starts with <details> or <summary> as an HTML block running to the
// next blank line, so a summary on its own line went out unescaped. The parse
// therefore reads a tag that ends its line as a blank line, as Telegram ends
// a block there (an indented line after it is code), and any other tag as an
// inert word of the same length, which keeps the indentation of the text
// after it and so the lists and quotes around it. The tags are found round by
// round, as each one settles the blocks after it; tags in code are dropped.
// Offsets stay those of md, and the tags are sent as written.
function parseLikeTelegram(md: string): { root: Root; tags: Tag[] } {
  let root = parse(md)
  const tags: Tag[] = []
  if (!/<\/?(details|summary)\b/i.test(md)) return { root, tags }
  let view = md
  for (let round = 0; round < 8; round++) {
    const found: Tag[] = []
    const visit = (node: Nodes, parent: Parents | undefined) => {
      if (node.type === 'html') {
        // Inline, or a block whose content is never Markdown: <pre>, a comment.
        if (parent && !FLOW_PARENTS.has(parent.type)) return
        if (/^\s*<(pre|script|style|textarea)\b|^\s*<!/i.test(node.value)) return
        const from = startOf(node)
        for (const m of view.slice(from, endOf(node)).matchAll(/<(\/?)(details|summary)\b[^>]*>/gi)) {
          const at = from + m.index!
          found.push({ from: at, to: at + m[0].length, open: m[2]!.toLowerCase() === 'summary' ? 0 : m[1] ? -1 : 1 })
        }
        return
      }
      if ('children' in node) for (const child of node.children as RootContent[]) visit(child, node as Parents)
    }
    visit(root, undefined)
    if (found.length === 0) break
    found.sort((a, b) => a.from - b.from)
    let next = ''
    let at = 0
    for (const t of found) {
      const tag = view.slice(t.from, t.to)
      const endsLine = !/[\r\n]/.test(tag) && /^[ \t]*(\r|\n|$)/.test(view.slice(t.to, t.to + 200))
      next += view.slice(at, t.from) + (endsLine ? ' '.repeat(tag.length - 1) + '\n' : tag.replace(/[^\r\n]/g, 'x'))
      at = t.to
    }
    view = next + view.slice(at)
    tags.push(...found)
    root = parse(view)
  }
  const code: [number, number][] = []
  const inCode = (node: Nodes) => {
    if (node.type === 'code' || node.type === 'inlineCode') code.push([startOf(node), endOf(node)])
    else if ('children' in node) for (const child of node.children as RootContent[]) inCode(child)
  }
  inCode(root)
  return { root, tags: tags.filter(t => !code.some(([a, b]) => t.from >= a && t.from < b)).sort((a, b) => a.from - b.from) }
}

// What Telegram would misread in md, by source offset. A $ in text can open a
// formula ("path $HOME/$USER" became math), so it gets a backslash. Only text
// nodes are touched: in code, autolinks and link URLs the backslash would
// show. A tag Telegram does not render becomes &lt;.
function collectEdits(md: string, root: Root): Map<number, Edit> {
  const edits = new Map<number, Edit>()
  const walk = (node: Nodes, parent: Parents | undefined) => {
    switch (node.type) {
      case 'text':
        for (let i = startOf(node); i < endOf(node); i++) {
          if (md[i] === '\\') i++
          else if (md[i] === '$') edits.set(i, { drop: 0, insert: '\\' })
        }
        return
      case 'html': {
        if (!parent || FLOW_PARENTS.has(parent.type)) return
        const at = startOf(node)
        const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(md.slice(at, at + 64))?.[1]
        if (name && !RICH_TAGS.has(name.toLowerCase()) && !HTML_TAGS.has(name)) edits.set(at, { drop: 1, insert: '&lt;' })
        return
      }
      case 'link':
        if (md[startOf(node)] === '<') return
        break
    }
    if ('children' in node) for (const child of node.children as RootContent[]) walk(child, node as Parents)
  }
  walk(root, undefined)
  return edits
}

// The rich Markdown Telegram is sent for md, whole.
export function richMarkdown(md: string): string {
  return new Rendered(md, parseLikeTelegram(md).root).render(0, md.length)
}

const isHigh = (c: number) => c >= 0xd800 && c < 0xdc00
const isLow = (c: number) => c >= 0xdc00 && c < 0xe000

class Rendered {
  private readonly edits: Map<number, Edit>
  // bytes[i] is the UTF-8 size of what md[0, i) renders to. A lone surrogate
  // goes out as U+FFFD, 3 bytes.
  private readonly bytes: Uint32Array
  constructor(readonly md: string, root: Root) {
    this.edits = collectEdits(md, root)
    this.bytes = new Uint32Array(md.length + 1)
    for (let i = 0; i < md.length; i++) {
      const c = md.charCodeAt(i)
      let n = c < 0x80 ? 1 : c < 0x800 ? 2 : 3
      if (isHigh(c) && isLow(md.charCodeAt(i + 1))) n = 4
      else if (isLow(c) && isHigh(md.charCodeAt(i - 1))) n = 0
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

// One message of a long reply: the text as written, and the rich Markdown
// for it, unless only plain text keeps it whole.
export type RichPart = { rich?: string; plain: string }

type Limits = { bytes: number; blocks: number }
type Span = { from: number; to: number; blocks: number; node?: RootContent; whole: boolean }

// Splits md into rich messages between top-level blocks, never inside a
// <details>. The spans cover md end to end, so no text is lost or sent twice.
// A block too big alone is cut where Markdown allows it: a code block is
// closed and reopened, a table repeats its header, a list or quote is cut
// between its items. Anything else that big goes out plain, as written.
export function richParts(md: string, limits: Limits = { bytes: RICH_PART_BYTES, blocks: RICH_PART_BLOCKS }): RichPart[] {
  const { root, tags } = parseLikeTelegram(md)
  const r = new Rendered(md, root)
  const starts: Span[] = []
  let depth = 0
  let floor = 0
  let t = 0
  let lastEnd = 0
  const open = (at: number, node?: RootContent) => {
    let from = at
    while (from > floor && md[from - 1] !== '\n' && md[from - 1] !== '\r') from--
    const last = starts.at(-1)
    if (last && from <= last.from) from = last.from
    if (last && from === last.from) {
      last.whole = false
      return last
    }
    const span: Span = { from, to: md.length, blocks: 0, node, whole: true }
    if (last) last.to = from
    starts.push(span)
    return span
  }
  for (const node of root.children) {
    const at = startOf(node)
    for (; t < tags.length && tags[t]!.from < at; t++) {
      const tag = tags[t]!
      // A <details> inside the last block, such as a list item, is part of it.
      if (tag.open === 1 && depth === 0 && tag.from >= lastEnd) open(tag.from).whole = false
      depth = Math.max(0, depth + tag.open)
      floor = tag.to
    }
    const span = depth === 0 ? open(at, node) : starts.at(-1)
    lastEnd = Math.max(lastEnd, endOf(node))
    if (!span) continue
    span.blocks++
    if (span.node !== node) span.whole = false
  }
  for (; t < tags.length; t++) {
    const tag = tags[t]!
    if (tag.open === 1 && depth === 0 && tag.from >= lastEnd) open(tag.from).whole = false
    depth = Math.max(0, depth + tag.open)
  }
  if (starts.length === 0) return [{ rich: md, plain: md }]
  starts[0]!.from = 0

  const parts: RichPart[] = []
  let cur: { from: number; to: number; blocks: number } | undefined
  const flush = () => {
    if (cur) parts.push({ rich: r.render(cur.from, cur.to), plain: md.slice(cur.from, cur.to) })
    cur = undefined
  }
  for (const s of starts) {
    const [from, to] = trim(md, s.from, s.to)
    if (from >= to) continue
    if (cur && r.size(cur.from, to) <= limits.bytes && cur.blocks + s.blocks <= limits.blocks) {
      cur.to = to
      cur.blocks += s.blocks
      continue
    }
    flush()
    if (r.size(from, to) <= limits.bytes) cur = { from, to, blocks: s.blocks }
    else parts.push(...cutBlock(r, from, to, s.whole ? s.node : undefined, limits))
  }
  flush()
  return parts
}

// [from, to) without its leading blank lines and trailing whitespace.
function trim(md: string, from: number, to: number): [number, number] {
  for (let i = from; i < to; i++) {
    if (md[i] === '\n' || md[i] === '\r') from = i + 1
    else if (md[i] !== ' ' && md[i] !== '\t') break
  }
  while (to > from && ' \t\r\n'.includes(md[to - 1]!)) to--
  return [from, to]
}

function lines(md: string, from: number, to: number): [number, number][] {
  const out: [number, number][] = []
  for (let s = from; s <= to; ) {
    let e = s
    while (e < to && md[e] !== '\n' && md[e] !== '\r') e++
    out.push([s, e])
    s = e + (md[e] === '\r' && md[e + 1] === '\n' ? 2 : 1)
  }
  return out
}

function cutBlock(r: Rendered, from: number, to: number, node: RootContent | undefined, limits: Limits): RichPart[] {
  const md = r.md
  const plain = [{ plain: md.slice(from, to) }]
  if (node?.type === 'list' || node?.type === 'blockquote') {
    // Each item or quoted block starts on its own line, prefix included.
    const kids: Span[] = []
    for (const child of node.children) {
      let at = startOf(child)
      while (at > from && md[at - 1] !== '\n' && md[at - 1] !== '\r') at--
      const last = kids.at(-1)
      if (last && at <= last.from) continue
      if (last) last.to = at
      kids.push({ from: kids.length ? at : from, to, blocks: 1, whole: true })
    }
    const out: RichPart[] = []
    let cur: [number, number] | undefined
    for (const k of kids) {
      const [a, b] = trim(md, k.from, k.to)
      if (a >= b) continue
      if (cur && r.size(cur[0], b) <= limits.bytes) {
        cur[1] = b
        continue
      }
      if (cur) out.push({ rich: r.render(cur[0], cur[1]), plain: md.slice(cur[0], cur[1]) })
      cur = undefined
      if (r.size(a, b) <= limits.bytes) cur = [a, b]
      else out.push({ plain: md.slice(a, b) })
    }
    if (cur) out.push({ rich: r.render(cur[0], cur[1]), plain: md.slice(cur[0], cur[1]) })
    return out
  }

  let body = lines(md, from, to)
  let head: [number, number] | undefined
  let tail = ''
  let hardCut = false
  const fence = node?.type === 'code' ? /^ {0,3}(`{3,}|~{3,})/.exec(md.slice(from, to))?.[1] : undefined
  if (fence) {
    head = body.shift()
    const last = body.at(-1)
    const close = last && /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(md.slice(last[0], last[1]))?.[1]
    if (close && close[0] === fence[0] && close.length >= fence.length) body.pop()
    tail = fence
    hardCut = true
  } else if (node?.type === 'table' && body.length > 2) {
    head = [body[0]![0], body[1]![1]]
    body = body.slice(2)
  } else if (node?.type !== 'code') return plain

  const headSize = head ? r.size(head[0], head[1]) + 1 : 0
  const room = limits.bytes - headSize - (tail ? tail.length + 1 : 0)
  if (room < limits.bytes / 2) return plain
  const wrap = (a: number, b: number): RichPart => {
    const join = (pre: string | undefined, mid: string) => (pre === undefined ? mid : `${pre}\n${mid}`) + (tail ? `\n${tail}` : '')
    return {
      rich: join(head && r.render(head[0], head[1]), r.render(a, b)),
      plain: join(head && md.slice(head[0], head[1]), md.slice(a, b)),
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
    // Inside a fence a line too long alone is cut by size; a low surrogate
    // costs no bytes, so the cut never lands inside a pair. Elsewhere a cut
    // line would change what it is, so the block goes out plain.
    if (r.size(start, end) > room && !hardCut) return plain
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

// The parser takes seconds on pathological Markdown (400 nested list levels
// took 5 s), and the server's one thread also polls, types and streams
// subagents. Parts are therefore computed in one worker for the session (a
// worker per call leaked half a megabyte each), replaced when a parse
// overruns ms. Text not split in time, or that the parser fails on, goes out
// plain as one part. Without a worker, as when its file does not load, parts
// are computed here.
export const RICH_PARSE_MS = 5000

type Pending = { text: string; limits?: Limits; resolve: (parts: RichPart[]) => void }
const pending = new Map<number, Pending>()
let worker: Worker | undefined
let workerLoaded = false
let workerBroken = false
let lastId = 0

function plainPart(text: string, why: string): RichPart[] {
  process.stderr.write(`telegram channel: rich parse failed, sending plain: ${why}\n`)
  return [{ plain: text }]
}

function partsHere(text: string, limits?: Limits): RichPart[] {
  try {
    return richParts(text, limits)
  } catch (err) {
    return plainPart(text, describe(err))
  }
}

function stopWorker(settle: (p: Pending) => RichPart[]): void {
  worker?.terminate()
  worker = undefined
  workerLoaded = false
  const waiting = [...pending.values()]
  pending.clear()
  for (const p of waiting) p.resolve(settle(p))
}

function startWorker(): Worker | undefined {
  if (worker || workerBroken) return worker
  try {
    const w = new Worker(new URL('./rich-worker.ts', import.meta.url).href)
    w.onmessage = (e: MessageEvent) => {
      if (e.data.loaded) {
        workerLoaded = true
        return
      }
      const p = pending.get(e.data.id)
      if (!p) return
      pending.delete(e.data.id)
      p.resolve(e.data.parts ?? plainPart(p.text, String(e.data.error)))
    }
    w.onerror = (e: ErrorEvent) => {
      // A worker that never loaded will not load next time either.
      if (!workerLoaded) {
        workerBroken = true
        process.stderr.write(`telegram channel: rich worker did not load, parsing in the server: ${e.message}\n`)
        stopWorker(p => partsHere(p.text, p.limits))
      } else stopWorker(p => plainPart(p.text, e.message))
    }
    w.unref()
    worker = w
  } catch (err) {
    workerBroken = true
    process.stderr.write(`telegram channel: rich worker did not start, parsing in the server: ${describe(err)}\n`)
  }
  return worker
}

export function richPartsAsync(text: string, limits?: Limits, ms = RICH_PARSE_MS): Promise<RichPart[]> {
  const w = startWorker()
  if (!w) return Promise.resolve(partsHere(text, limits))
  const id = ++lastId
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return
      resolve(plainPart(text, `no result in ${ms} ms`))
      // The worker is stuck on this text; what waits behind it goes plain too.
      stopWorker(p => plainPart(p.text, 'parser restarted'))
    }, ms)
    pending.set(id, {
      text,
      limits,
      resolve: parts => {
        clearTimeout(timer)
        resolve(parts)
      },
    })
    w.postMessage({ id, text, limits })
  })
}

// Sends text as rich messages; a part Telegram rejects, or one only plain
// text keeps whole, goes out plain, cut by plainChunks. Message ids land in
// progress.ids as they are sent, and progress.done counts finished parts of
// progress.total, so a failure part way reports what already went out.
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
  const parts = await richPartsAsync(opts.text)
  progress.total = parts.length
  const replyParams = () => {
    const to = opts.replyTo(progress.ids.length)
    return to != null ? { reply_parameters: { message_id: to, allow_sending_without_reply: true } } : {}
  }
  for (const part of parts) {
    if (part.rich !== undefined) {
      try {
        const sent = await raw.sendRichMessage({ chat_id: chatId, rich_message: { markdown: part.rich }, ...replyParams() })
        progress.ids.push(sent.message_id)
        progress.done++
        continue
      } catch (err) {
        if (!plainFallback(err)) throw err
        process.stderr.write(`telegram channel: rich message rejected, sending plain: ${describe(err)}\n`)
      }
    }
    for (const text of opts.plainChunks(part.plain)) {
      const sent = await raw.sendMessage({ chat_id: chatId, text, ...replyParams() })
      progress.ids.push(sent.message_id)
    }
    progress.done++
  }
}

// Edits a message into rich text; if Telegram rejects the content, into plain.
// Only Telegram's size limit applies here: an edit has no second message.
export async function editRich(opts: { raw: RawApi; chatId: string; messageId: number; text: string }): Promise<void> {
  const parts = await richPartsAsync(opts.text, { bytes: RICH_PART_BYTES, blocks: Infinity })
  if (parts.length > 1) throw new Error('text too long for one rich message: send it with reply instead')
  const rich = parts[0]?.rich
  if (rich !== undefined) {
    try {
      await opts.raw.editMessageText({ chat_id: opts.chatId, message_id: opts.messageId, rich_message: { markdown: rich } })
      return
    } catch (err) {
      if (!plainFallback(err)) throw err
      process.stderr.write(`telegram channel: rich edit rejected, editing plain: ${describe(err)}\n`)
    }
  }
  await opts.raw.editMessageText({ chat_id: opts.chatId, message_id: opts.messageId, text: opts.text })
}

function describe(err: unknown): string {
  return String((err as { description?: string })?.description ?? (err instanceof Error ? err.message : err))
}
