// A reaction the sender adds to a message the bot sent reaches Claude at once,
// as its own event: the emoji, the reacted message's id and, when the server
// remembers it, that message's opening words. It is the sender's reaction,
// never text they typed.
//
// Only standard emoji the update adds count, the new reaction minus the old:
// a switch delivers the new emoji, a second emoji beside the first delivers
// the second, and a removal delivers nothing. Custom-emoji and paid reactions
// deliver nothing. A reaction on one of the sender's own messages delivers
// nothing either; a message neither memory holds, such as one sent before the
// server started, goes by its number alone, so an answer is never lost.

import type { MessageReactionUpdated } from 'grammy/types'
import type { Inbound } from './batch.ts'

// How much of a sent message the server keeps for the event.
export const OPENING_CHARS = 100

// A message's opening words, on one line, cut at a code point.
export function opening(text: string, max = OPENING_CHARS): string {
  const points = [...text.replace(/\s+/g, ' ').trim()]
  return points.length > max ? points.slice(0, max - 1).join('') + '…' : points.join('')
}

type Memory = { get(chat: string, id: number): string | undefined }

// The event for a reaction update, given the standard emoji it adds (grammY's
// ctx.reactions().emojiAdded), the memory of the messages the sender sent and
// the memory of the opening words of the messages the bot sent; undefined
// when it adds none, has no sender, or reacts to the sender's own message.
export function reactionEvent(
  r: MessageReactionUpdated,
  added: readonly string[],
  inbound: Memory,
  sent: Memory,
): Inbound | undefined {
  if (added.length === 0 || !r.user) return undefined
  const chat_id = String(r.chat.id)
  if (inbound.get(chat_id, r.message_id) !== undefined) return undefined
  const words = sent.get(chat_id, r.message_id)
  const emoji = added.join(' ')
  return {
    content: `${emoji} on message ${r.message_id}${words ? `: "${words}"` : ''}`,
    meta: {
      chat_id,
      message_id: String(r.message_id),
      reaction: emoji,
      user: r.user.username ?? String(r.user.id),
      user_id: String(r.user.id),
      ts: new Date(r.date * 1000).toISOString(),
    },
  }
}
