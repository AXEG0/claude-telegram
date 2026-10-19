// An edit of a message the sender already sent reaches Claude as its own
// event: the message's new text or caption, under the message's own
// message_id, marked edited="true".
//
// Telegram also sends edited_message for changes that are not a person
// correcting text, such as a live location moving, and "at times" for changes
// to fields the bot does not use. So only an edit that carries text or a
// caption becomes an event, and only when that text differs from what Claude
// last got for the message.

import type { Message } from 'grammy/types'
import type { Inbound } from './batch.ts'
import { replyMeta } from './reply.ts'

// Media whose caption the sender can edit.
const CAPTIONED = ['photo', 'video', 'animation', 'document', 'audio', 'voice', 'paid_media'] as const

// The edit as Claude receives it, and the text compared with what Claude last
// got for the message; undefined for an edit that carries no text or caption,
// or no sender.
export function editEvent(msg: Message, botUsername?: string): { text: string; item: Inbound } | undefined {
  const text = msg.text ?? msg.caption
  if (text === undefined || !msg.from) return undefined
  const kind = msg.text === undefined ? CAPTIONED.find(k => msg[k] != null) : undefined
  return {
    text,
    item: {
      content: text,
      meta: {
        chat_id: String(msg.chat.id),
        message_id: String(msg.message_id),
        edited: 'true',
        user: msg.from.username ?? String(msg.from.id),
        user_id: String(msg.from.id),
        // When the edit was made; the message keeps its message_id.
        ts: new Date((msg.edit_date ?? msg.date) * 1000).toISOString(),
        ...replyMeta(msg, botUsername),
        ...(kind ? { attachment_kind: kind } : {}),
      },
    },
  }
}

// The text Claude last got for each recent message: the text or caption of a
// delivered message, or of its last delivered edit. A message the memory does
// not hold, sent before the server started or pushed out by newer ones,
// counts as changed.
export const TEXT_MEMORY = 1000

export function createTextMemory(max = TEXT_MEMORY) {
  const texts = new Map<string, string>()
  const remember = (chat: string, id: number, text: string) => {
    const key = `${chat}:${id}`
    texts.delete(key)
    texts.set(key, text)
    if (texts.size > max) texts.delete(texts.keys().next().value!)
  }
  return {
    remember,
    // The text held for the message, or undefined when the memory does not
    // hold it.
    get: (chat: string, id: number): string | undefined => texts.get(`${chat}:${id}`),
    // Whether text differs from what Claude last got for the message; if so,
    // it becomes what Claude last got.
    changed(chat: string, id: number, text: string): boolean {
      if (texts.get(`${chat}:${id}`) === text) return false
      remember(chat, id, text)
      return true
    },
  }
}
