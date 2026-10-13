import { describe, expect, test } from 'bun:test'
import { createPeers, noticeChat, type Peer } from './bots.ts'

function peers(users: Record<string, Peer | Error> = {}) {
  const lookups: string[] = []
  const p = createPeers(async id => {
    lookups.push(id)
    const user = users[id]
    if (user instanceof Error) throw user
    return user ?? { is_bot: false }
  })
  return { p, lookups }
}

describe('where a message goes', () => {
  test('a bot that wrote gets its @username, and no lookup', async () => {
    const { p, lookups } = peers()
    p.learn({ id: 8606571973, is_bot: true, username: 'lana_7491_bot' })
    expect(await p.target('8606571973')).toBe('@lana_7491_bot')
    expect(lookups).toEqual([])
  })

  test('a person with a username keeps the numeric id', async () => {
    const { p, lookups } = peers({ '6': { is_bot: false, username: 'someone' } })
    p.learn({ id: 64024129, is_bot: false, username: 'axego' })
    expect(await p.target('64024129')).toBe('64024129')
    expect(await p.target('6')).toBe('6')
    expect(lookups).toEqual(['6'])
  })

  test('a chat not heard from asks Telegram once, and keeps the answer', async () => {
    const { p, lookups } = peers({ '7777': { is_bot: true, username: 'quiet_bot' } })
    expect(await p.target('7777')).toBe('@quiet_bot')
    expect(await p.target('7777')).toBe('@quiet_bot')
    expect(await p.target('5')).toBe('5')
    expect(await p.target('5')).toBe('5')
    expect(lookups).toEqual(['7777', '5'])
    expect(p.isBot('7777')).toBe(true)
  })

  test('a group asks nothing and keeps its id', async () => {
    const { p, lookups } = peers()
    expect(await p.target('-1001654782309')).toBe('-1001654782309')
    expect(lookups).toEqual([])
  })

  test('a failed lookup fails the send, and the next send asks again', async () => {
    const users: Record<string, Peer | Error> = { '9': new Error('Bad Request: member not found') }
    const { p, lookups } = peers(users)
    await expect(p.target('9')).rejects.toThrow('could not tell whether chat 9 is a bot: Bad Request: member not found')
    users['9'] = { is_bot: true, username: 'later_bot' }
    expect(await p.target('9')).toBe('@later_bot')
    expect(lookups).toEqual(['9', '9'])
  })

  test('a bot without a username fails the send rather than going to its id', async () => {
    const { p } = peers({ '11': { is_bot: true } })
    await expect(p.target('11')).rejects.toThrow('bot 11 has no username')
  })

  test('a bot that writes again with a new username gets it', async () => {
    const { p } = peers()
    p.learn({ id: 12, is_bot: true, username: 'old_bot' })
    p.learn({ id: 12, is_bot: true, username: 'new_bot' })
    expect(await p.target('12')).toBe('@new_bot')
  })
})

describe('where a notice goes', () => {
  test('a person’s chat keeps it, a bot’s chat hands it to the owner chat', () => {
    const { p } = peers()
    p.learn({ id: 5, is_bot: false, username: 'manager' })
    p.learn({ id: 8606571973, is_bot: true, username: 'lana_7491_bot' })
    expect(noticeChat('5', p, '64024129')).toBe('5')
    expect(noticeChat('8606571973', p, '64024129')).toBe('64024129')
    expect(noticeChat('-100', p, '64024129')).toBe('-100')
    expect(noticeChat(undefined, p, '64024129')).toBeUndefined()
  })

  test('with no owner chat, a bot’s notice goes nowhere', () => {
    const { p } = peers()
    p.learn({ id: 8606571973, is_bot: true, username: 'lana_7491_bot' })
    expect(noticeChat('8606571973', p, undefined)).toBeUndefined()
  })

  test('a chat the server knows nothing about keeps its notice', () => {
    const { p } = peers()
    expect(p.isBot('5')).toBe(false)
    expect(noticeChat('5', p, '1')).toBe('5')
  })
})
