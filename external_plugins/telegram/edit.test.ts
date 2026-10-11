import { describe, expect, test } from 'bun:test'
import type { Message } from 'grammy/types'
import { createTextMemory, editEvent } from './edit.ts'

const owner = { id: 1, is_bot: false, first_name: 'Owner', username: 'owner' }
const chat = { id: 1, type: 'private' as const, first_name: 'Owner' }
const SENT = 1_791_500_000
const EDITED = SENT + 90
const edited = (extra: Record<string, unknown>) =>
  ({ message_id: 50, date: SENT, edit_date: EDITED, chat, from: owner, ...extra }) as unknown as Message
const photo = [{ file_id: 'f', file_unique_id: 'u', width: 1, height: 1 }]

describe('editEvent', () => {
  test('a text edit: the new text under the message id, marked edited, at the edit time', () => {
    expect(editEvent(edited({ text: 'deploy to prod' }), 'argylle_bot')).toEqual({
      text: 'deploy to prod',
      item: {
        content: 'deploy to prod',
        meta: {
          chat_id: '1', message_id: '50', edited: 'true', user: 'owner', user_id: '1',
          ts: new Date(EDITED * 1000).toISOString(),
        },
      },
    })
  })

  test('a caption edit names the media the caption belongs to', () => {
    const p = editEvent(edited({ photo, caption: 'the left one' }))!
    expect(p.item.content).toBe('the left one')
    expect(p.item.meta.attachment_kind).toBe('photo')
    expect(p.item.meta.edited).toBe('true')
    const d = editEvent(edited({ document: { file_id: 'd', file_unique_id: 'v', file_name: 'a.pdf' }, caption: 'page 3' }))!
    expect(d.item.content).toBe('page 3')
    expect(d.item.meta.attachment_kind).toBe('document')
    // A caption edit carries no file to fetch: the file came with the message.
    expect(d.item.meta.attachment_file_id).toBeUndefined()
  })

  test('an edit that carries no text or caption is no event', () => {
    // A live location moving, a caption-less photo, a poll.
    expect(editEvent(edited({ location: { latitude: 41.7, longitude: 44.8, live_period: 900 } }))).toBeUndefined()
    expect(editEvent(edited({ photo }))).toBeUndefined()
    expect(editEvent(edited({ poll: { id: 'p', question: 'q', options: [] } }))).toBeUndefined()
  })

  test('an edit with no sender is no event', () => {
    expect(editEvent(edited({ text: 'x', from: undefined }))).toBeUndefined()
  })

  test('an edited reply keeps what it replies to', () => {
    const bot = { id: 7, is_bot: true, first_name: 'Argylle', username: 'argylle_bot' }
    const e = editEvent(edited({ text: 'no, the second', reply_to_message: { message_id: 40, date: 0, chat, from: bot, text: 'Which one?' } }), 'argylle_bot')!
    expect(e.item.meta).toMatchObject({ reply_to_message_id: '40', reply_to_user: 'this bot', reply_to_text: 'Which one?' })
  })

  test('a sender without a username goes by id; ts falls back to the send time', () => {
    const e = editEvent(edited({ text: 'x', from: { id: 9, is_bot: false, first_name: 'N' }, edit_date: undefined }))!
    expect(e.item.meta.user).toBe('9')
    expect(e.item.meta.ts).toBe(new Date(SENT * 1000).toISOString())
  })
})

describe('createTextMemory', () => {
  test('an edit counts only when its text differs from what Claude last got', () => {
    const m = createTextMemory()
    m.remember('1', 50, 'deploy to staging')
    expect(m.changed('1', 50, 'deploy to staging')).toBe(false)
    expect(m.changed('1', 50, 'deploy to prod')).toBe(true)
    expect(m.changed('1', 50, 'deploy to prod')).toBe(false)
    // The same id in another chat is another message.
    expect(m.changed('2', 50, 'deploy to prod')).toBe(true)
  })

  test('a message it never saw counts as changed', () => {
    expect(createTextMemory().changed('1', 50, 'anything')).toBe(true)
  })

  test('a caption added to a photo sent without one counts as changed', () => {
    const m = createTextMemory()
    m.remember('1', 50, '')
    expect(m.changed('1', 50, 'the left one')).toBe(true)
  })

  test('it holds the newest messages only', () => {
    const m = createTextMemory(2)
    m.remember('1', 1, 'a')
    m.remember('1', 2, 'b')
    m.remember('1', 3, 'c')
    expect(m.changed('1', 1, 'a')).toBe(true)
    expect(m.changed('1', 3, 'c')).toBe(false)
  })
})
