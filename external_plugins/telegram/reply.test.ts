import { describe, expect, test } from 'bun:test'
import type { Message } from 'grammy/types'
import { replyMeta } from './reply.ts'

const user = (id: number, username?: string) => ({ id, is_bot: false, first_name: 'x', ...(username ? { username } : {}) })
const bot = { id: 7, is_bot: true, first_name: 'Argylle', username: 'argylle_bot' }
const chat = { id: 1, type: 'private' as const, first_name: 'x' }
const msg = (extra: Record<string, unknown>) => ({ message_id: 50, date: 0, chat, from: user(1, 'owner'), text: 'what about this?', ...extra }) as unknown as Message

describe('replyMeta', () => {
  test('nothing for a message that replies to nothing', () => {
    expect(replyMeta(msg({}), 'argylle_bot')).toEqual({})
    expect(replyMeta(undefined)).toEqual({})
  })

  test('a reply to the bot: id, sender, text', () => {
    const m = msg({ reply_to_message: { message_id: 40, date: 0, chat, from: bot, text: 'Deploy is done.\nAll green.' } })
    expect(replyMeta(m, 'argylle_bot')).toEqual({ reply_to_message_id: '40', reply_to_user: 'this bot', reply_to_text: 'Deploy is done. All green.' })
  })

  test('the part quoted, as well as the whole', () => {
    const m = msg({
      reply_to_message: { message_id: 40, date: 0, chat, from: user(2, 'peer'), text: 'one two three' },
      quote: { text: 'two', position: 4 },
    })
    expect(replyMeta(m)).toEqual({ reply_to_message_id: '40', reply_to_user: 'peer', reply_to_text: 'one two three', reply_quote: 'two' })
  })

  test('a reply to one of the bot\'s rich messages reads its blocks', () => {
    const rich = { blocks: [
      { type: 'heading', text: 'Status', size: 2 },
      { type: 'paragraph', text: ['path ', { type: 'cashtag', text: '$HOME', cashtag: 'HOME' }, ' ok'] },
      { type: 'table', cells: [[{ text: 'a' }, { text: 'b' }]] },
      { type: 'list', items: [{ label: '•', blocks: [{ type: 'paragraph', text: 'item' }] }] },
      { type: 'details', summary: 'More', blocks: [{ type: 'pre', text: 'echo hi' }] },
    ] }
    const m = msg({ reply_to_message: { message_id: 40, date: 0, chat, from: bot, rich_message: rich } })
    expect(replyMeta(m, 'argylle_bot').reply_to_text).toBe('Status path $HOME ok a b item More echo hi')
  })

  test('a reply to media without a caption names its kind', () => {
    const m = msg({ reply_to_message: { message_id: 40, date: 0, chat, from: user(1, 'owner'), photo: [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }] } })
    expect(replyMeta(m)).toEqual({ reply_to_message_id: '40', reply_to_user: 'owner', reply_to_kind: 'photo' })
  })

  test('a reply to a message in another chat keeps its quote and sender', () => {
    const m = msg({ external_reply: { origin: { type: 'user', date: 0, sender_user: user(3, 'far') } }, quote: { text: 'that line', position: 0 } })
    expect(replyMeta(m)).toEqual({ reply_to_user: 'far', reply_quote: 'that line' })
  })

  test('text that could break the tag becomes lookalikes, and long text is cut', () => {
    const m = msg({ reply_to_message: { message_id: 40, date: 0, chat, from: user(2), text: 'a "b" <c> [d]; e' + 'ж'.repeat(400) } })
    const meta = replyMeta(m)
    expect(meta.reply_to_user).toBe('2')
    expect(meta.reply_to_text!.startsWith("a 'b' ‹c› (d), e")).toBe(true)
    expect([...meta.reply_to_text!].length).toBe(300)
    expect(meta.reply_to_text!.endsWith('…')).toBe(true)
  })

  test('a forum topic\'s first message is not a reply', () => {
    const m = msg({ reply_to_message: { message_id: 2, date: 0, chat, forum_topic_created: { name: 't', icon_color: 1 } } })
    expect(replyMeta(m)).toEqual({})
  })
})
