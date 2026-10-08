// What a Telegram message replies to, as meta for its <channel> tag: the
// replied message's id, its sender, its text (shortened), and the part the
// sender quoted, if any. Telegram sends these with the message; the Bot API
// keeps no history to look them up later.

import type { Message } from 'grammy/types'

const TEXT_MAX = 300
const QUOTE_MAX = 500
const MEDIA = ['photo', 'video', 'animation', 'voice', 'audio', 'video_note', 'document', 'sticker', 'location', 'poll'] as const

// Meta values land inside the <channel> tag. Characters that could close the
// tag or forge an entry become lookalikes, lines are joined, and long text is
// cut at a code point.
function metaText(s: string, max: number): string {
  const flat = s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[<>[\];"]/g, c => ({ '<': '‹', '>': '›', '[': '(', ']': ')', ';': ',', '"': "'" })[c]!)
  const points = [...flat]
  return points.length > max ? points.slice(0, max - 1).join('') + '…' : flat
}

// The text of a rich message, block by block, for a reply to one of the bot's
// rich replies, which carry no plain text.
type RichNode = { text?: unknown; summary?: unknown; expression?: unknown; blocks?: RichNode[]; items?: RichNode[]; cells?: RichNode[][] }
function inline(x: unknown): string {
  if (typeof x === 'string') return x
  if (Array.isArray(x)) return x.map(inline).join('')
  if (x && typeof x === 'object') {
    const n = x as RichNode
    return inline(n.text ?? n.expression ?? '')
  }
  return ''
}
function block(b: RichNode): string {
  return [
    inline(b.summary),
    inline(b.text),
    typeof b.expression === 'string' ? b.expression : '',
    ...(b.blocks ?? []).map(block),
    ...(b.items ?? []).map(block),
    ...(b.cells ?? []).flat().map(c => inline(c.text)),
  ].filter(Boolean).join(' ')
}
function richText(m: object): string | undefined {
  const blocks = (m as { rich_message?: { blocks?: RichNode[] } }).rich_message?.blocks
  return blocks ? blocks.map(block).join(' ') : undefined
}

export function replyMeta(msg: Message | undefined, botUsername?: string): Record<string, string> {
  if (!msg) return {}
  // In a forum topic every message replies to the topic's first message.
  const reply = msg.reply_to_message?.forum_topic_created ? undefined : msg.reply_to_message
  const external = msg.external_reply
  const quote = msg.quote?.text ?? ''
  if (!reply && !external && !quote.trim()) return {}

  const meta: Record<string, string> = {}
  const id = reply?.message_id ?? external?.message_id
  if (id != null) meta.reply_to_message_id = String(id)
  const from = reply?.from ?? (external?.origin.type === 'user' ? external.origin.sender_user : undefined)
  if (from) meta.reply_to_user = botUsername && from.username === botUsername ? 'this bot' : from.username ?? String(from.id)
  const text = reply ? reply.text ?? reply.caption ?? richText(reply) : undefined
  if (text?.trim()) meta.reply_to_text = metaText(text, TEXT_MAX)
  const target = (reply ?? external) as Record<string, unknown> | undefined
  const media = MEDIA.find(k => target?.[k] != null)
  if (media) meta.reply_to_kind = media
  if (quote.trim()) meta.reply_quote = metaText(quote, QUOTE_MAX)
  return meta
}
