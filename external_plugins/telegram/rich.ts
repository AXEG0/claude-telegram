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
import type { Nodes, Parents, Root, RootContent, Table } from 'mdast'
import { keyboardRefused } from './buttons.ts'

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

// One line of the server's instructions, which Claude Code cuts at 4096
// characters; it goes last, so a cut takes it before the access warning.
export const RICH_INSTRUCTIONS =
  'Rich messages: replies and edits render GitHub Markdown: headings, tables (inline formatting, up to 20 columns), task lists, code, ' +
  '<details><summary>…</summary>…</details>, ==marked==, ||spoiler||. A literal == or || goes in backticks. Math only as <tg-math>…</tg-math>; a $ stays a dollar sign.'

const RICH_FORMAT_HELP =
  "Rendering mode. 'rich' (the default) sends GitHub Markdown as a Telegram rich message (tables, headings, details). 'text' is plain, no escaping needed. 'markdownv2' enables Telegram formatting (bold, italic, code, links); caller must escape special chars per MarkdownV2 rules."
const PLAIN_FORMAT_HELP =
  "Rendering mode. 'markdownv2' enables Telegram formatting (bold, italic, code, links). Caller must escape special chars per MarkdownV2 rules. Default: 'text' (plain, no escaping needed)."

// The formats reply and edit_message take, with rich messages on or off. The
// same list is the tools' schema and the check on each call, so a format the
// schema does not list is refused, never sent as plain text.
const formats = (rich: boolean): string[] => rich ? ['rich', 'text', 'markdownv2'] : ['text', 'markdownv2']

// The format property of reply's and edit_message's schemas.
export const formatSchema = (rich: boolean) => ({
  type: 'string',
  enum: formats(rich),
  description: rich ? RICH_FORMAT_HELP : PLAIN_FORMAT_HELP,
})

// The format a call asked for: the default when it passes none, else its value
// when the list holds it exactly. Any other value, null included, is refused,
// naming the value, the list and what the call left undone.
export function formatOf(value: unknown, rich: boolean, undone: string): string {
  if (value === undefined) return rich ? 'rich' : 'text'
  const list = formats(rich)
  if (typeof value === 'string' && list.includes(value)) return value
  throw new Error(`format ${JSON.stringify(value)} is not one of ${list.join(', ')}, so ${undone}. ${formatSchema(rich).description}`)
}

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

// gap marks a blank line above a table, which a part carries only when it
// still fits every limit with it (Rendered.part).
type Edit = { drop: number; insert: string; gap?: true }
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
function collectEdits(md: string, root: Root, tags: Tag[]): Map<number, Edit> {
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
  tableGaps(md, root, tags, edits)
  return edits
}

// Telegram's limits on a table's columns and on levels of nested formatting
// and blocks (Bot API, Rich Message Limits).
const TABLE_COLUMNS = 20
const RICH_LEVELS = 16
const SECTION_TAG = /<\/?(details|summary)\b/i
// The HTML tags the page builds text from (Rich HTML style); <a> is not one,
// as the page also builds a block from <a name>. A table cell holds text only
// (RichBlockTableCell), so how Telegram reads any other tag there, or a
// Markdown image, which can be a photo, video or other media block, is not known.
const TEXT_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'mark', 'sub', 'sup', 'br',
  'tg-spoiler', 'tg-reference', 'tg-emoji', 'tg-time', 'tg-math', 'tg-button',
])
// A backslash escape, which GFM reads as text.
const ESCAPED = /\\[!-\/:-@[-`{-~]/g
// Tags that close nothing: HTML's void elements, and any tag written as <x/>.
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
type HtmlTag = { at: number; name: string; open: boolean; void: boolean }

// Every tag of raw HTML Telegram reads as a tag, in source order, none sent as
// &lt;. Of the <details> and <summary> tags read above, which the parse no
// longer holds, the summary tags. A comment is one entry named '!', which no
// cell may hold; how Telegram reads its inside was never sent, so each tag
// there counts as an element opened, closed only by a later closing tag of its
// name while it is the innermost open element. A tag ends at the first '>', so
// a node is read only up to its last '>': a '<' after it starts no tag, and
// each '<' before it is read once, which keeps a long node linear.
function htmlTags(md: string, root: Root, tags: Tag[], edits: Map<number, Edit>): HtmlTag[] {
  const out: HtmlTag[] = tags.filter(t => t.open === 0).map(t => ({ at: t.from, name: 'summary', open: md[t.from + 1] !== '/', void: false }))
  const read = (from: number, text: string) => {
    for (const m of text.slice(0, text.lastIndexOf('>') + 1).matchAll(/<(\/?)([A-Za-z][A-Za-z0-9-]*)\b[^>]*?(\/?)>|<[!?][^>]*>/g)) {
      const at = from + m.index!
      if (m[2] === undefined) out.push({ at, name: '!', open: true, void: true })
      else if (edits.get(at)?.insert !== '&lt;') out.push({ at, name: m[2].toLowerCase(), open: !m[1], void: VOID_TAGS.has(m[2].toLowerCase()) || !!m[3] })
    }
  }
  const walk = (node: Nodes) => {
    if (node.type === 'html') {
      const from = startOf(node), text = md.slice(from, endOf(node))
      let at = 0
      for (let c = text.indexOf('<!--'); c >= 0; c = text.indexOf('<!--', at)) {
        read(from + at, text.slice(at, c))
        out.push({ at: from + c, name: '!', open: true, void: true })
        const end = text.indexOf('-->', c + 4)
        at = end < 0 ? text.length : end + 3
        const n = out.length
        read(from + c + 4, text.slice(c + 4, end < 0 ? text.length : end))
        for (let i = n; i < out.length; i++) out[i] = { ...out[i]!, open: true, void: false }
      }
      read(from + at, text.slice(at))
      return
    }
    if ('children' in node) for (const child of node.children as Nodes[]) walk(child)
  }
  walk(root)
  return out.sort((a, b) => a.at - b.at)
}

// Telegram reads a table right under a paragraph as that paragraph's text;
// one blank line, with the container's quote markers, lets it start a table.
// The line goes in only where what Telegram reads is known: no lone CR, and
// inside <details> only as sent live. The table it makes stays within
// Telegram's columns and levels, counted with every level it may count.
function tableGaps(md: string, root: Root, tags: Tag[], edits: Map<number, Edit>): void {
  const html = htmlTags(md, root, tags, edits)
  // The index of the first tag at or after at.
  const first = (at: number) => {
    let lo = 0, hi = html.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (html[mid]!.at < at) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  const within = (from: number, to: number) => html.slice(first(from), first(to))
  // opened[i]: how many elements of raw HTML stand open before html[i], such
  // as a collage or a quote written as a tag, whose reading of a table inside
  // was never sent. A closing tag closes the innermost element, and only when
  // it names it; any other closing tag closes nothing.
  const opened = [0]
  const stack: string[] = []
  for (const t of html) {
    if (!t.void && t.open) stack.push(t.name)
    else if (!t.void && stack.at(-1) === t.name) stack.pop()
    opened.push(stack.length)
  }
  const inside = (at: number) => opened[first(at)]! > 0
  // Whether the tags in [from, to) close every tag they open, and only those.
  const closed = (from: number, to: number) => {
    const stack: string[] = []
    for (const t of within(from, to)) {
      if (t.void) continue
      if (t.open) stack.push(t.name)
      else if (stack.pop() !== t.name) return false
    }
    return stack.length === 0
  }
  // Whether the line would split what Telegram reads as one: in main's text
  // the paragraph and table are one paragraph, so a tag, a == or a || pair
  // can open in one block or cell and close in another. Each text is read
  // each way Telegram may read it: as written, with its backslash escapes as
  // text, and as the parse decodes it, as GFM reads an escaped | in a cell. A
  // character reference holds no = or |. Three or more = or | in a row were
  // never sent. The counts of == and of || in each reading, summed over the
  // block or cell, or none for a run of three.
  const count = (s: string) => /={3}|\|{3}/.test(s) ? undefined : [s.split('==').length - 1, s.split('||').length - 1]
  const marks = (n: Nodes): number[] | undefined => {
    if (n.type === 'text') {
      const raw = md.slice(startOf(n), endOf(n))
      const r = [count(raw), count(raw.replace(ESCAPED, m => ' '.repeat(m.length))), count(n.value)]
      return r.every(Boolean) ? r.flat() as number[] : undefined
    }
    let sum = [0, 0, 0, 0, 0, 0]
    if ('children' in n) for (const c of n.children as Nodes[]) {
      const m = marks(c)
      if (!m) return undefined
      sum = sum.map((x, i) => x + m[i]!)
    }
    return sum
  }
  const whole = (n: Nodes) => closed(startOf(n), endOf(n)) && !!marks(n)?.every(c => c % 2 === 0)
  // A cell holds text only: no image, and no tag the page builds no text from.
  const media = (n: Nodes): boolean =>
    n.type === 'image' || n.type === 'imageReference' || ('children' in n && (n.children as Nodes[]).some(media))
  // A || between two cells is a cell boundary to GFM and a spoiler's mark to
  // Telegram in main's text, where the table is paragraph text.
  const pipes = (table: Table) => md.slice(startOf(table), endOf(table)).includes('||')
  const textOnly = (table: Table) => !media(table) && within(startOf(table), endOf(table)).every(t => TEXT_TAGS.has(t.name)) &&
    table.children.every(row => row.children.every(whole)) && !pipes(table)
  const lone = (from: number, to: number) => {
    for (let i = from; i <= to; i++) if (md[i] === '\r' && md[i + 1] !== '\n') return true
    return false
  }
  const lineStart = (at: number) => at === 0 || md[at - 1] === '\n' || md[at - 1] === '\r'
  const visit = (node: Nodes, levels: number) => {
    if (!('children' in node) || node.type === 'footnoteDefinition') return
    const kids = node.children as RootContent[]
    for (let k = 1; k < kids.length; k++) {
      const prev = kids[k - 1]!, table = kids[k]!
      if (table.type !== 'table' || prev.type !== 'paragraph') continue
      const from = startOf(prev), to = endOf(table)
      if (lone(from, to) || SECTION_TAG.test(md.slice(from, to)) || inside(from) || !whole(prev) || !textOnly(table)) continue
      // The <details> sections open at the paragraph, innermost last.
      const open: Tag[] = []
      for (const t of tags) {
        if (t.from >= from) break
        if (t.open === 1) open.push(t)
        else if (t.open === -1) open.pop()
      }
      if (open.length > 0) {
        const close = tags.find(t => t.from >= to)
        if (node.type !== 'root' || open.length !== 1 || !lineStart(open[0]!.from)) continue
        if (!close || close.open !== -1 || !lineStart(close.from) || SECTION_TAG.test(md.slice(from, close.from))) continue
      }
      let columns = 0
      for (const row of table.children) columns = Math.max(columns, row.children.length)
      if (columns > TABLE_COLUMNS || levels + open.length + tableLevels(table) > RICH_LEVELS) continue
      // The delimiter row: the line after the head row's LF or CRLF.
      let e = startOf(table)
      while (e < md.length && md[e] !== '\n' && md[e] !== '\r') e++
      const d = /^[ \t>]*/.exec(md.slice(e + (md[e] === '\r' ? 2 : 1)))![0]
      // A list marker that cannot interrupt a paragraph (an ordered one not numbered 1, or an empty item)
      // opens a list once a blank line is above it, so that head row keeps main's text.
      if (/^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(md.slice(startOf(table), e))) continue
      const gap = /^(\r\n|\n)([ \t>]*)$/.exec(md.slice(endOf(prev), startOf(table)))
      if (!gap || gap[2] !== d) continue
      edits.set(endOf(prev), { drop: 0, insert: gap[1] + d.replace(/[ \t]+$/, ''), gap: true })
    }
    for (const c of kids) visit(c, levels + 1)
  }
  visit(root, 0)
}

// The levels a table takes, each one Telegram may count: the table, a row, a
// cell, then the cell's formatting, each node of it one. A footnote reference
// is two, as Telegram makes it a superscript holding a link. A text is one,
// for an entity Telegram may find in it (a mention, hashtag, cashtag, command,
// link, e-mail, phone or card number; none sits inside another). Each tag of
// raw HTML is one more, and so is each == or || in a text, which Telegram
// reads as marked text or a spoiler where GFM reads neither.
function tableLevels(table: Table): number {
  const nest = (n: Nodes): number => {
    if (n.type === 'html') return 0
    if (n.type === 'text') return 1
    if (n.type === 'footnoteReference') return 2
    let most = 0
    if ('children' in n) for (const c of n.children as Nodes[]) most = Math.max(most, nest(c))
    return 1 + most
  }
  const more = (n: Nodes): number => {
    if (n.type === 'html') return n.value.split('<').length - 1
    if (n.type === 'text') return n.value.split(/==|\|\|/).length - 1
    let sum = 0
    if ('children' in n) for (const c of n.children as Nodes[]) sum += more(c)
    return sum
  }
  let most = 0
  for (const row of table.children) for (const cell of row.children) most = Math.max(most, nest(cell) - 1 + more(cell))
  return 3 + most
}

// Node types that are no block of Telegram's: text, its formatting, a table
// cell (table rows count). Raw HTML and images are counted apart.
const NOT_BLOCKS = new Set([
  'text', 'emphasis', 'strong', 'delete', 'inlineCode', 'break', 'link', 'linkReference',
  'footnoteReference', 'tableCell',
])

// The rich Markdown Telegram is sent for md, whole, with every blank line
// above a table.
export function richMarkdown(md: string): string {
  const { root, tags } = parseLikeTelegram(md)
  return new Rendered(md, root, tags).render(0, md.length, true)
}

const isHigh = (c: number) => c >= 0xd800 && c < 0xdc00
const isLow = (c: number) => c >= 0xdc00 && c < 0xe000

class Rendered {
  private readonly edits: Map<number, Edit>
  // bytes[i] is the UTF-8 size of what md[0, i) renders to, without the blank
  // lines above tables, so every cut falls where it falls without them. A lone
  // surrogate goes out as U+FFFD, 3 bytes. gaps[i] is the size those lines
  // add. blocks[i] counts the blocks starting in md[0, i) as Telegram's page
  // counts them toward its limit: nested blocks, list items, table rows,
  // quotes and <details> sections included, and two per image or tag of raw
  // HTML, a Markdown image inside raw HTML included: each opens at most one
  // block, a media block for an image, and the text after it one paragraph.
  private readonly bytes: Uint32Array
  private readonly gaps: Uint32Array
  private readonly blocks: Uint32Array
  constructor(readonly md: string, root: Root, tags: Tag[]) {
    this.edits = collectEdits(md, root, tags)
    this.bytes = new Uint32Array(md.length + 1)
    this.gaps = new Uint32Array(md.length + 1)
    this.blocks = new Uint32Array(md.length + 1)
    const starts = new Uint32Array(md.length + 1)
    const count = (node: Nodes) => {
      if (node.type === 'html') starts[startOf(node)] += 2 * (node.value.split(/<|!\[/).length - 1)
      else if (node.type === 'image' || node.type === 'imageReference') starts[startOf(node)] += 2
      else if (node.type !== 'root' && !NOT_BLOCKS.has(node.type)) starts[startOf(node)]++
      if ('children' in node) for (const child of node.children as Nodes[]) count(child)
    }
    count(root)
    for (const t of tags) if (t.open === 1) starts[t.from]++
    for (let i = 0; i < md.length; i++) {
      const c = md.charCodeAt(i)
      let n = c < 0x80 ? 1 : c < 0x800 ? 2 : 3
      if (isHigh(c) && isLow(md.charCodeAt(i + 1))) n = 4
      else if (isLow(c) && isHigh(md.charCodeAt(i - 1))) n = 0
      const e = this.edits.get(i)
      const g = e?.gap ? Buffer.byteLength(e.insert) : 0
      if (e && !e.gap) n = Buffer.byteLength(e.insert) + (e.drop ? 0 : n)
      this.bytes[i + 1] = this.bytes[i]! + n
      this.gaps[i + 1] = this.gaps[i]! + g
      this.blocks[i + 1] = this.blocks[i]! + starts[i]!
    }
  }
  size(from: number, to: number): number {
    return this.bytes[to]! - this.bytes[from]!
  }
  // The rich Markdown for md[from, to), with its blank lines above tables
  // only when gaps is set.
  render(from: number, to: number, gaps = false): string {
    let out = ''
    let at = from
    for (let i = from; i < to; i++) {
      const e = this.edits.get(i)
      if (!e || (e.gap && !gaps)) continue
      out += this.md.slice(at, i) + e.insert
      at = i + e.drop
    }
    return out + this.md.slice(at, to)
  }
  // The part for md[from, to). It carries its blank lines above tables only
  // when, with them, it stays within bytes and within the block budget of a
  // reply's part, counting reopened, a container a cut opens again; else its
  // rich Markdown is the text without them, as main sends it.
  part(from: number, to: number, bytes: number, reopened = 0): RichPart {
    const added = this.gaps[to]! - this.gaps[from]!
    const fits = this.size(from, to) + added <= bytes && this.blocks[to]! - this.blocks[from]! + reopened <= RICH_PART_BLOCKS
    return { rich: this.render(from, to, added > 0 && fits), plain: this.md.slice(from, to) }
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
  const r = new Rendered(md, root, tags)
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
    if (cur) parts.push(r.part(cur.from, cur.to, limits.bytes))
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
      if (cur) out.push(r.part(cur[0], cur[1], limits.bytes, startOf(node) < cur[0] ? 1 : 0))
      cur = undefined
      if (r.size(a, b) <= limits.bytes) cur = [a, b]
      else out.push({ plain: md.slice(a, b) })
    }
    if (cur) out.push(r.part(cur[0], cur[1], limits.bytes, startOf(node) < cur[0] ? 1 : 0))
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
  editMessageText(params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
}

// The plain text of a RichText as Telegram returns it in a message's
// rich_message: a string, an array of RichText, or a typed piece holding its
// text, such as a link, a mention or a bot command Telegram detected on its
// own. undefined for a value of any other shape.
export function richTextPlain(text: unknown): string | undefined {
  if (typeof text === 'string') return text
  if (Array.isArray(text)) {
    let out = ''
    for (const piece of text) {
      const plain = richTextPlain(piece)
      if (plain === undefined) return undefined
      out += plain
    }
    return out
  }
  if (!text || typeof text !== 'object') return undefined
  const piece = text as { type?: unknown; text?: unknown; alternative_text?: unknown; expression?: unknown }
  if ('text' in piece) return richTextPlain(piece.text)
  if (piece.type === 'custom_emoji' && typeof piece.alternative_text === 'string') return piece.alternative_text
  if (piece.type === 'mathematical_expression' && typeof piece.expression === 'string') return piece.expression
  return undefined
}

// The text of a rich message made of plain paragraphs, as Telegram returns its
// blocks: each paragraph's text flattened, line breaks inside it kept, and the
// paragraphs joined by line breaks. undefined when the blocks are missing or
// hold anything but paragraphs.
export function paragraphsText(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks) || blocks.length === 0) return undefined
  const lines: string[] = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'paragraph') return undefined
    const plain = richTextPlain((block as { text?: unknown }).text)
    if (plain === undefined) return undefined
    lines.push(plain)
  }
  return lines.join('\n')
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
// progress.total, so a failure part way reports what already went out;
// with markup given, progress.carrying says whether the send in flight
// carries it.
// markup goes on the last message sent: the last part, or the last message
// of its plain fallback. A call carrying it that Telegram refuses for the
// keyboard fails at once, with no plain copy.
export async function sendRich(opts: {
  raw: RawApi
  chatId: string
  text: string
  // The message to reply to for the nth message sent, if any.
  replyTo: (n: number) => number | undefined
  plainChunks: (text: string) => string[]
  progress: { ids: number[]; done: number; total: number; carrying?: boolean }
  // Called for each message sent, with the text Claude wrote for it.
  sent?: (messageId: number, text: string) => void
  markup?: object
}): Promise<void> {
  const { raw, chatId, progress } = opts
  const parts = await richPartsAsync(opts.text)
  progress.total = parts.length
  const replyParams = () => {
    const to = opts.replyTo(progress.ids.length)
    return to != null ? { reply_parameters: { message_id: to, allow_sending_without_reply: true } } : {}
  }
  for (let p = 0; p < parts.length; p++) {
    const part = parts[p]!
    const markup = opts.markup && p === parts.length - 1 ? { reply_markup: opts.markup } : {}
    if (part.rich !== undefined) {
      try {
        if (opts.markup) progress.carrying = 'reply_markup' in markup
        const sent = await raw.sendRichMessage({ chat_id: chatId, rich_message: { markdown: part.rich }, ...replyParams(), ...markup })
        progress.ids.push(sent.message_id)
        opts.sent?.(sent.message_id, part.plain)
        progress.done++
        continue
      } catch (err) {
        if ('reply_markup' in markup && keyboardRefused(err)) throw err
        if (!plainFallback(err)) throw err
        process.stderr.write(`telegram channel: rich message rejected, sending plain: ${describe(err)}\n`)
      }
    }
    const chunks = opts.plainChunks(part.plain)
    for (let i = 0; i < chunks.length; i++) {
      const text = chunks[i]!
      if (opts.markup) progress.carrying = i === chunks.length - 1 && 'reply_markup' in markup
      const sent = await raw.sendMessage({ chat_id: chatId, text, ...replyParams(), ...(i === chunks.length - 1 ? markup : {}) })
      progress.ids.push(sent.message_id)
      opts.sent?.(sent.message_id, text)
    }
    progress.done++
  }
}

// Edits a message into rich text; if Telegram rejects the content, into plain.
// Only Telegram's size limit applies here: an edit has no second message.
export async function editRich(opts: { raw: RawApi; chatId: string; messageId: number; text: string }): Promise<void> {
  await editRichParsed({ ...opts, rich: await richEditParse(opts.text) })
}

// The rich Markdown for an edit to text, or undefined when only plain text
// keeps it whole; parsed before any lock is taken.
export async function richEditParse(text: string): Promise<string | undefined> {
  const parts = await richPartsAsync(text, { bytes: RICH_PART_BYTES, blocks: Infinity })
  if (parts.length > 1) throw new Error('text too long for one rich message: send it with reply instead')
  return parts[0]?.rich
}

// The edit itself, with markup in the same call, its plain fallback included;
// a refusal of the keyboard fails at once, with no plain edit. limit wraps
// each call, as a call made under the button lock gives up in time.
export async function editRichParsed(opts: {
  raw: RawApi
  chatId: string
  messageId: number
  text: string
  rich: string | undefined
  markup?: object
  limit?: <T>(run: (signal?: AbortSignal) => Promise<T>) => Promise<T>
}): Promise<void> {
  const limit = opts.limit ?? (run => run())
  const markup = opts.markup ? { reply_markup: opts.markup } : {}
  if (opts.rich !== undefined) {
    try {
      await limit(signal => opts.raw.editMessageText({ chat_id: opts.chatId, message_id: opts.messageId, rich_message: { markdown: opts.rich }, ...markup }, signal))
      return
    } catch (err) {
      if (opts.markup && keyboardRefused(err)) throw err
      if (!plainFallback(err)) throw err
      process.stderr.write(`telegram channel: rich edit rejected, editing plain: ${describe(err)}\n`)
    }
  }
  await limit(signal => opts.raw.editMessageText({ chat_id: opts.chatId, message_id: opts.messageId, text: opts.text, ...markup }, signal))
}

function describe(err: unknown): string {
  return String((err as { description?: string })?.description ?? (err instanceof Error ? err.message : err))
}
