import { describe, expect, test } from 'bun:test'
import { Api, Context } from 'grammy'
import type { MessageReactionUpdated, ReactionType, UserFromGetMe } from 'grammy/types'
import { createTextMemory, TEXT_MEMORY } from './edit.ts'
import { opening, OPENING_CHARS, reactionEvent } from './reaction.ts'

const owner = { id: 1, is_bot: false, first_name: 'Owner', username: 'owner' }
const emoji = (e: string): ReactionType => ({ type: 'emoji', emoji: e as never })
const update = (message_id: number, old_reaction: ReactionType[], new_reaction: ReactionType[], user: typeof owner | null = owner): MessageReactionUpdated => ({
  chat: { id: 1, type: 'private', first_name: 'Owner' },
  message_id,
  ...(user ? { user } : {}),
  date: 1_700_000_000,
  old_reaction,
  new_reaction,
})
// The emoji grammY reports as added, as the server reads them.
const me = { id: 2, is_bot: true, first_name: 'Test', username: 'test' } as UserFromGetMe
const added = (r: MessageReactionUpdated) => new Context({ update_id: 1, message_reaction: r }, new Api('0:x'), me).reactions().emojiAdded
const none = createTextMemory()
const event = (r: MessageReactionUpdated, inbound = none, sent = none) => reactionEvent(r, added(r), inbound, sent)

describe('reactionEvent', () => {
  test('an emoji on a message the bot sent: its id, the emoji and its opening words, marked as a reaction', () => {
    const sent = createTextMemory()
    sent.remember('1', 10, 'Deploy finished')
    expect(event(update(10, [], [emoji('👍')]), none, sent)).toEqual({
      content: '👍 on message 10: "Deploy finished"',
      meta: { chat_id: '1', message_id: '10', reaction: '👍', user: 'owner', user_id: '1', ts: new Date(1_700_000_000_000).toISOString() },
    })
  })

  test('a message neither memory holds goes by its number alone', () => {
    expect(event(update(11, [], [emoji('👍')]))?.content).toBe('👍 on message 11')
  })

  test('a reaction on a message the sender sent is no event, even one the bot also holds words for', () => {
    const inbound = createTextMemory()
    inbound.remember('1', 12, 'ship it')
    const sent = createTextMemory()
    sent.remember('1', 12, 'not this')
    expect(event(update(12, [], [emoji('👍')]), inbound, sent)).toBeUndefined()
    // A photo the sender sent without a caption is held with empty text.
    inbound.remember('1', 13, '')
    expect(event(update(13, [], [emoji('👍')]), inbound)).toBeUndefined()
  })

  test('only standard emoji the update adds count: a switch gives the new one, a second gives the second, a removal nothing', () => {
    expect(event(update(10, [emoji('👍')], [emoji('👎')]))?.meta.reaction).toBe('👎')
    expect(event(update(10, [emoji('👍')], [emoji('👍'), emoji('❤')]))?.meta.reaction).toBe('❤')
    expect(event(update(10, [emoji('👍')], []))).toBeUndefined()
    expect(event(update(10, [emoji('👍')], [emoji('👍')]))).toBeUndefined()
  })

  test('custom-emoji and paid reactions are no event, and standard emoji beside them still count', () => {
    const custom: ReactionType = { type: 'custom_emoji', custom_emoji_id: 'custom-1' }
    const paid: ReactionType = { type: 'paid' }
    expect(event(update(10, [], [custom]))).toBeUndefined()
    expect(event(update(10, [], [paid]))).toBeUndefined()
    expect(event(update(10, [emoji('👍')], [emoji('👍'), custom]))).toBeUndefined()
    expect(event(update(10, [custom], [emoji('🔥')]))?.meta.reaction).toBe('🔥')
  })

  test('two emoji added at once go in one event', () => {
    expect(event(update(10, [], [emoji('👍'), emoji('🔥')]))).toMatchObject({ content: '👍 🔥 on message 10', meta: { reaction: '👍 🔥' } })
  })

  test('a reaction with no sender is no event; a sender without a username goes by id', () => {
    expect(event(update(10, [], [emoji('👍')], null))).toBeUndefined()
    const { username: _, ...plain } = owner
    expect(event(update(10, [], [emoji('👍')], plain as typeof owner))?.meta.user).toBe('1')
  })

  test('the sent memory holds the newest messages only, so the oldest then goes by its number', () => {
    const sent = createTextMemory()
    for (let id = 1; id <= TEXT_MEMORY + 1; id++) sent.remember('1', id, `message ${id}`)
    expect(event(update(1, [], [emoji('👍')]), none, sent)?.content).toBe('👍 on message 1')
    expect(event(update(2, [], [emoji('👍')]), none, sent)?.content).toBe('👍 on message 2: "message 2"')
  })
})

describe('opening', () => {
  test('one line, cut at a code point to the opening characters', () => {
    expect(opening('  Deploy finished.\n\nAll checks pass.  ')).toBe('Deploy finished. All checks pass.')
    const long = '🔥'.repeat(OPENING_CHARS + 5)
    expect(opening(long)).toBe('🔥'.repeat(OPENING_CHARS - 1) + '…')
    expect(opening('🔥'.repeat(OPENING_CHARS))).toBe('🔥'.repeat(OPENING_CHARS))
  })
})
