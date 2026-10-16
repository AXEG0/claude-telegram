import { describe, expect, test } from 'bun:test'
import { BOT_USERNAME, CHAT_ID, createBotLookup, createConfirm, createPeers, listed, noticeChat, PeerError, plainObject, sendStyle, type Peer } from './bots.ts'

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

describe('whether a chat is a bot’s', () => {
  test('from what the server heard, else from Telegram once; a group asks nothing', async () => {
    const { p, lookups } = peers({ '7777': { is_bot: true, username: 'quiet_bot' } })
    p.learn({ id: 8606571973, is_bot: true, username: 'lana_7491_bot' })
    p.learn({ id: 5, is_bot: false })
    expect(await p.botChat('8606571973')).toBe(true)
    expect(await p.botChat('5')).toBe(false)
    expect(await p.botChat('7777')).toBe(true)
    expect(await p.target('7777')).toBe('@quiet_bot')
    expect(await p.botChat('6')).toBe(false)
    expect(await p.botChat('-100')).toBe(false)
    expect(lookups).toEqual(['7777', '6'])
  })

  test('a failed lookup fails, as a send to the chat would', async () => {
    const { p } = peers({ '9': new Error('Bad Request: member not found') })
    await expect(p.botChat('9')).rejects.toThrow('could not tell whether chat 9 is a bot')
  })
})

describe('how a reply or an edit goes', () => {
  test('to a bot, plain whatever the format', () => {
    for (const format of ['rich', 'markdownv2', 'text', 'other']) expect(sendStyle(format, true)).toBe('text')
  })

  test('to a person or a group, as asked', () => {
    expect(sendStyle('rich', false)).toBe('rich')
    expect(sendStyle('markdownv2', false)).toBe('markdownv2')
    expect(sendStyle('text', false)).toBe('text')
    expect(sendStyle('other', false)).toBe('text')
  })
})

// A promise a test settles by hand, to hold a call open.
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// Usernames of made-up bots.
const SEVEN = 'Seven_PeerBot'
const SEVEN_LOWER = 'seven_peerbot'
const STORED = 'stored_seven_bot'
const NEW = 'new_seven_bot'
const OLD = 'old_seven_bot'
const WROTE = 'wrote_seven_bot'
const LOOKED = 'looked_up_seven_bot'
const PEER = 'seven_peer_bot'
const RIGHT = 'right_one_bot'

// What Telegram's fields carry in these tests, so an error can be searched for it.
const MARKER = 'text-telegram-returned'

describe('which lists and ids count', () => {
  test('only an array counts as a list, matched by element', () => {
    expect(listed(['1', '2345'], '2345')).toBe(true)
    expect(listed(['1', '2345'], '234')).toBe(false)
    expect(listed('12345', '234')).toBe(false)
    expect(listed('12345', '12345')).toBe(false)
    expect(listed({ '23': true }, '23')).toBe(false)
    expect(listed([23], '23')).toBe(false)
    expect(listed(undefined, '23')).toBe(false)
    expect(listed(null, '23')).toBe(false)
  })

  test('a chat id is numeric, without a leading zero', () => {
    for (const id of ['1', '7001', '-100', '-1001']) expect(CHAT_ID.test(id)).toBe(true)
    for (const id of ['0', '-0', '0123', '-0100', '1.5', '1e3', '', ' 1', 'constructor', 'toString', '@somebot', '+1']) {
      expect(CHAT_ID.test(id)).toBe(false)
    }
  })

  test('a bot username is 5 to 32 letters, digits and underscores ending in bot in any case', () => {
    for (const name of ['TetrisBot', 'tetris_bot', 'abBOT', 'Fresh_PeerBot', 'a'.repeat(29) + 'bot']) expect(BOT_USERNAME.test(name)).toBe(true)
    for (const name of ['abot', 'a'.repeat(30) + 'bot', 'peer_bat', 'peer-bot', '@' + 'peerbot', 'peer bot', 'botpeer', 'пирbot']) {
      expect(BOT_USERNAME.test(name)).toBe(false)
    }
  })

  test('a plain object is an object that is not null or an array', () => {
    expect(plainObject({})).toBe(true)
    for (const v of [[], null, 'x', 1, true, undefined]) expect(plainObject(v)).toBe(false)
  })
})

// Telegram as the fallback sees it: getChatMember answers by id, and getChat
// by username. An unopened user's chat opens with a getChat by its username.
function telegram(opts: {
  users?: Record<string, Peer & { id: number }>
  unopened?: string[]
  closed?: string[]
  names?: Record<string, number>
  refuse?: string[]
  flood?: string[]
} = {}) {
  const calls: string[] = []
  const lines: string[] = []
  const opened = new Set<string>()
  const refuse = (description: string, error_code = 400, parameters: object = {}) =>
    Object.assign(new Error(`Call to 'x' failed! (${error_code}: ${description})`), { error_code, description, parameters })
  const getChatMember = async (id: string) => {
    calls.push(`getChatMember ${id}`)
    if (opts.flood?.includes(id)) throw refuse('Too Many Requests: retry after 7', 429, { retry_after: 7 })
    if (opts.closed?.includes(id) || (opts.unopened?.includes(id) && !opened.has(id))) throw refuse('Bad Request: chat not found')
    const user = opts.users?.[id]
    if (!user) throw refuse('Bad Request: member not found')
    return { ...user, first_name: MARKER } as Peer
  }
  const getChat = async (chatId: string) => {
    calls.push(`getChat ${chatId}`)
    const name = chatId.slice(1).toLowerCase()
    if (opts.refuse?.includes(name)) throw refuse('Bad Request: chat not found')
    const id = opts.names?.[name] ?? Object.values(opts.users ?? {}).find(u => u.username?.toLowerCase() === name)?.id
    if (id === undefined) throw refuse('Bad Request: chat not found')
    opened.add(String(id))
    return { id, type: 'private', username: chatId.slice(1), first_name: MARKER, bio: MARKER, description: MARKER }
  }
  return { calls, lines, getChatMember, getChat }
}

function fallback(t: ReturnType<typeof telegram>, access: { allowFrom: unknown; botUsernames: unknown }) {
  return createBotLookup({ getChatMember: t.getChatMember, getChat: t.getChat, access: () => access, log: line => t.lines.push(line) })
}

async function failsWith(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    expect(text).not.toContain(MARKER)
    return text
  }
  throw new Error('expected a failure')
}

describe('the first message to a bot that never wrote', () => {
  const BOT7 = { id: 7, is_bot: true, username: SEVEN }

  test('a chat getChatMember describes needs no getChat', async () => {
    const t = telegram({ users: { '7': BOT7 } })
    const lookup = fallback(t, { allowFrom: ['7'], botUsernames: { '7': SEVEN } })
    expect((await lookup('7')).username).toBe(SEVEN)
    expect(t.calls).toEqual(['getChatMember 7'])
  })

  test('an unopened chat opens by the stored username, and the answer is the user getChatMember then gives', async () => {
    const t = telegram({ users: { '7': BOT7 }, unopened: ['7'] })
    const lookup = fallback(t, { allowFrom: ['1', '7'], botUsernames: { '7': SEVEN } })
    const user = await lookup('7')
    expect(user.is_bot).toBe(true)
    expect(user.username).toBe(SEVEN)
    expect(t.calls).toEqual(['getChatMember 7', `getChat @${SEVEN}`, 'getChatMember 7'])
    expect(t.lines).toEqual([`opened chat 7 by @${SEVEN}`])
  })

  test('a stored username in another case is the same name, and the send takes the case Telegram gives', async () => {
    const t = telegram({ users: { '7': BOT7 }, unopened: ['7'] })
    const lookup = fallback(t, { allowFrom: ['7'], botUsernames: { '7': SEVEN_LOWER } })
    expect((await lookup('7')).username).toBe(SEVEN)
    expect(t.calls).toEqual(['getChatMember 7', `getChat @${SEVEN_LOWER}`, 'getChatMember 7'])
  })

  test('a username whose chat is another id sends nothing and writes no opened line', async () => {
    const t = telegram({ users: { '7': BOT7 }, unopened: ['7'], names: { seven_peerbot: 99 } })
    const lookup = fallback(t, { allowFrom: ['7'], botUsernames: { '7': SEVEN } })
    expect(await failsWith(lookup('7'))).toBe(`@${SEVEN} is chat 99, not 7`)
    expect(t.calls).toEqual(['getChatMember 7', `getChat @${SEVEN}`])
    expect(t.lines).toEqual([])
  })

  test('a refused getChat fails with its method, code and description, and writes no opened line', async () => {
    const t = telegram({ users: { '7': BOT7 }, unopened: ['7'], refuse: [SEVEN_LOWER] })
    const lookup = fallback(t, { allowFrom: ['7'], botUsernames: { '7': SEVEN } })
    expect(await failsWith(lookup('7'))).toBe(`could not open chat 7 by @${SEVEN}: getChat failed (400: Bad Request: chat not found)`)
    expect(t.lines).toEqual([])
  })

  test('a getChatMember after getChat that fails or describes no bot sends nothing', async () => {
    const closed = telegram({ users: { '7': BOT7 }, closed: ['7'] })
    expect(await failsWith(fallback(closed, { allowFrom: ['7'], botUsernames: { '7': SEVEN } })('7')))
      .toBe(`chat 7 opened by @${SEVEN}, but getChatMember failed (400: Bad Request: chat not found)`)
    const person = telegram({ users: { '7': { ...BOT7, is_bot: false } }, unopened: ['7'] })
    expect(await failsWith(fallback(person, { allowFrom: ['7'], botUsernames: { '7': SEVEN } })('7')))
      .toBe(`chat 7 is not a bot, so nothing goes to @${SEVEN}`)
    const nameless = telegram({ users: { '7': { id: 7, is_bot: true } }, unopened: ['7'], names: { seven_peerbot: 7 } })
    expect(await failsWith(fallback(nameless, { allowFrom: ['7'], botUsernames: { '7': SEVEN } })('7')))
      .toBe('bot 7 has no username to send to')
  })

  test('a username Telegram gives other than the stored one is used only once getChat by it returns the id', async () => {
    const access = { allowFrom: ['7'], botUsernames: { '7': STORED } }
    const ok = telegram({ users: { '7': BOT7 }, unopened: ['7'], names: { stored_seven_bot: 7 } })
    expect((await fallback(ok, access)('7')).username).toBe(SEVEN)
    expect(ok.calls).toEqual(['getChatMember 7', `getChat @${STORED}`, 'getChatMember 7', `getChat @${SEVEN}`])

    const elsewhere = telegram({ users: { '7': BOT7 }, unopened: ['7'], names: { stored_seven_bot: 7, seven_peerbot: 98 } })
    const moved = await failsWith(fallback(elsewhere, access)('7'))
    expect(moved).toBe('the username Telegram gives for 7 is chat 98, not 7')
    expect(moved.toLowerCase()).not.toContain(SEVEN_LOWER)

    const refused = telegram({ users: { '7': BOT7 }, unopened: ['7'], names: { stored_seven_bot: 7 }, refuse: [SEVEN_LOWER] })
    const gone = await failsWith(fallback(refused, access)('7'))
    expect(gone).toBe('could not check the username Telegram gives for 7: getChat failed (400: Bad Request: chat not found)')
    expect(gone.toLowerCase()).not.toContain(SEVEN_LOWER)
  })

  test('flood control fails as it is, retry figure included, with no getChat', async () => {
    const t = telegram({ users: { '7': BOT7 }, flood: ['7'] })
    const err = await failsWith(fallback(t, { allowFrom: ['7'], botUsernames: { '7': SEVEN } })('7'))
    expect(err).toContain('retry after 7')
    expect(t.calls).toEqual(['getChatMember 7'])
  })

  test('an id not in an allowFrom array, or a map without an own entry for it, fails as getChatMember did, with no getChat', async () => {
    const cases: { allowFrom: unknown; botUsernames: unknown }[] = [
      { allowFrom: ['1'], botUsernames: { '7': SEVEN } },
      { allowFrom: '17', botUsernames: { '7': SEVEN } },
      { allowFrom: { '7': true }, botUsernames: { '7': SEVEN } },
      { allowFrom: ['7'], botUsernames: undefined },
      { allowFrom: ['7'], botUsernames: SEVEN },
      { allowFrom: ['7'], botUsernames: [SEVEN] },
      { allowFrom: ['7'], botUsernames: null },
      { allowFrom: ['7'], botUsernames: { '8': SEVEN } },
      { allowFrom: ['7'], botUsernames: Object.create({ '7': SEVEN }) },
    ]
    for (const access of cases) {
      const t = telegram({ users: { '7': BOT7 }, unopened: ['7'] })
      expect(await failsWith(fallback(t, access)('7'))).toBe("Call to 'x' failed! (400: Bad Request: chat not found)")
      expect(t.calls).toEqual(['getChatMember 7'])
    }
  })

  test('an entry the rule rejects fails with its own error, without its value, and with no getChat', async () => {
    for (const value of ['seven_peerbat', 'Seven-PeerBot', `@${SEVEN}`, 'abot', 7, null, [SEVEN], { name: SEVEN }]) {
      const t = telegram({ users: { '7': BOT7 }, unopened: ['7'] })
      const err = await failsWith(fallback(t, { allowFrom: ['7'], botUsernames: { '7': value } })('7'))
      expect(err).toBe('botUsernames entry for 7 is not a bot username')
      expect(t.calls).toEqual(['getChatMember 7'])
    }
  })

  test('access is read at each lookup, so an entry added later counts', async () => {
    const t = telegram({ users: { '7': BOT7 }, unopened: ['7'] })
    const access: { allowFrom: unknown; botUsernames: unknown } = { allowFrom: ['7'], botUsernames: {} }
    const lookup = fallback(t, access)
    await failsWith(lookup('7'))
    access.botUsernames = { '7': SEVEN }
    expect((await lookup('7')).username).toBe(SEVEN)
  })
})

describe('confirming a username', () => {
  test('passes when getChat returns the chat, and names only ids otherwise', async () => {
    const confirm = createConfirm(async chatId => ({ id: chatId === `@${RIGHT}` ? 7 : 99, first_name: MARKER }))
    await confirm('7', RIGHT)
    const err = await failsWith(confirm('7', 'wrong_one_bot'))
    expect(err).toBe('the username Telegram gives for 7 is chat 99, not 7')
    const refused = createConfirm(async () => { throw Object.assign(new Error('x'), { error_code: 400, description: 'Bad Request: chat not found' }) })
    expect(await failsWith(refused('7', 'gone_one_bot'))).toBe('could not check the username Telegram gives for 7: getChat failed (400: Bad Request: chat not found)')
  })
})

describe('after a message to a bot went elsewhere', () => {
  // A lookup and a confirm a test answers by hand.
  function held(confirmed = true) {
    const lookups: ReturnType<typeof deferred<Peer>>[] = []
    const confirms: { chatId: string; username: string; done: ReturnType<typeof deferred<void>> }[] = []
    const p = createPeers(
      () => { const d = deferred<Peer>(); lookups.push(d); return d.promise },
      (chatId, username) => {
        const done = deferred<void>()
        confirms.push({ chatId, username, done })
        if (confirmed === false) done.reject(new PeerError(`the username Telegram gives for ${chatId} is chat 99, not ${chatId}`))
        return done.promise
      },
    )
    return { p, lookups, confirms }
  }
  const tick = () => Bun.sleep(5)

  test('isBot and botChat keep answering true with no call, and the next target asks again and keeps the answer once confirm passes', async () => {
    const { p, lookups, confirms } = held()
    p.learn({ id: 7, is_bot: true, username: 'old_seven_bot' })
    p.forget('7')
    expect(p.isBot('7')).toBe(true)
    expect(await p.botChat('7')).toBe(true)
    expect(noticeChat('7', p, '1')).toBe('1')
    expect(lookups).toHaveLength(0)
    const target = p.target('7')
    await tick()
    lookups[0]!.resolve({ is_bot: true, username: NEW })
    await tick()
    expect(confirms.map(c => [c.chatId, c.username])).toEqual([['7', NEW]])
    confirms[0]!.done.resolve()
    expect(await target).toBe(`@${NEW}`)
    // Kept: the next target is a cache hit.
    expect(await p.target('7')).toBe(`@${NEW}`)
    expect(lookups).toHaveLength(1)
  })

  test('a confirm that fails keeps the forgotten entry, sends nothing, and the next target asks again', async () => {
    const { p, lookups, confirms } = held(false)
    p.learn({ id: 7, is_bot: true, username: 'old_seven_bot' })
    p.forget('7')
    const target = p.target('7')
    await tick()
    lookups[0]!.resolve({ is_bot: true, username: 'old_seven_bot' })
    expect(await failsWith(target)).toBe('the username Telegram gives for 7 is chat 99, not 7')
    expect(confirms).toHaveLength(1)
    expect(p.isBot('7')).toBe(true)
    const again = p.target('7')
    await tick()
    expect(lookups).toHaveLength(2)
    lookups[1]!.resolve({ is_bot: true, username: 'old_seven_bot' })
    await failsWith(again)
  })

  test('a lookup that describes no bot, or a bot with no username, keeps the forgotten entry and gets no confirm', async () => {
    for (const [answer, error] of [
      [{ is_bot: false, username: 'seven_person' }, 'Telegram no longer describes chat 7 as a bot'],
      [{ is_bot: true }, 'bot 7 has no username to send to'],
    ] as [Peer, string][]) {
      const { p, lookups, confirms } = held()
      p.learn({ id: 7, is_bot: true, username: 'old_seven_bot' })
      p.forget('7')
      const target = p.target('7')
      await tick()
      lookups[0]!.resolve(answer)
      expect(await failsWith(target)).toBe(error)
      expect(confirms).toHaveLength(0)
      expect(p.isBot('7')).toBe(true)
      expect(await p.botChat('7')).toBe(true)
      expect(noticeChat('7', p, '1')).toBe('1')
    }
  })

  test('with no confirm given, a forgotten entry keeps nothing and sends nothing', async () => {
    const lookups: string[] = []
    const p = createPeers(async id => { lookups.push(id); return { is_bot: true, username: NEW } })
    p.learn({ id: 7, is_bot: true, username: 'old_seven_bot' })
    p.forget('7')
    expect(await failsWith(p.target('7'))).toBe('bot 7 needs its username checked and no check was given')
    expect(await failsWith(p.target('7'))).toBe('bot 7 needs its username checked and no check was given')
    expect(lookups).toEqual(['7', '7'])
    expect(p.isBot('7')).toBe(true)
  })

  test('a lookup still running when forget is called keeps its answer only once confirm passes', async () => {
    const { p, lookups, confirms } = held()
    const first = p.target('7')
    await tick()
    p.forget('7')
    lookups[0]!.resolve({ is_bot: true, username: PEER })
    await tick()
    expect(confirms).toHaveLength(1)
    confirms[0]!.done.resolve()
    expect(await first).toBe(`@${PEER}`)

    const failing = held(false)
    const second = failing.p.target('7')
    await tick()
    failing.p.forget('7')
    failing.lookups[0]!.resolve({ is_bot: true, username: PEER })
    await failsWith(second)
    expect(failing.p.isBot('7')).toBe(false)
  })

  test('an answer whose confirm overlapped another forget goes through confirm again', async () => {
    const { p, lookups, confirms } = held()
    p.learn({ id: 7, is_bot: true, username: 'old_seven_bot' })
    p.forget('7')
    const target = p.target('7')
    await tick()
    lookups[0]!.resolve({ is_bot: true, username: NEW })
    await tick()
    expect(confirms).toHaveLength(1)
    p.forget('7')
    confirms[0]!.done.resolve()
    await tick()
    expect(confirms).toHaveLength(2)
    confirms[1]!.done.resolve()
    expect(await target).toBe(`@${NEW}`)
    expect(lookups).toHaveLength(1)
  })

  test('a message from the bot while the lookup is open keeps its own entry, with no confirm; a forget after it brings confirm back', async () => {
    const learned = held()
    learned.p.learn({ id: 7, is_bot: true, username: 'old_seven_bot' })
    learned.p.forget('7')
    const target = learned.p.target('7')
    await tick()
    learned.p.learn({ id: 7, is_bot: true, username: WROTE })
    learned.lookups[0]!.resolve({ is_bot: true, username: LOOKED })
    expect(await target).toBe(`@${WROTE}`)
    expect(learned.confirms).toHaveLength(0)
    expect(await learned.p.target('7')).toBe(`@${WROTE}`)

    const forgotten = held()
    forgotten.p.learn({ id: 7, is_bot: true, username: 'old_seven_bot' })
    forgotten.p.forget('7')
    const next = forgotten.p.target('7')
    await tick()
    forgotten.p.learn({ id: 7, is_bot: true, username: WROTE })
    forgotten.p.forget('7')
    forgotten.lookups[0]!.resolve({ is_bot: true, username: LOOKED })
    await tick()
    expect(forgotten.confirms.map(c => c.username)).toEqual([LOOKED])
    forgotten.confirms[0]!.done.resolve()
    expect(await next).toBe(`@${LOOKED}`)
  })

  test('a message from the bot while confirm runs keeps its own entry', async () => {
    const { p, lookups, confirms } = held()
    p.learn({ id: 7, is_bot: true, username: 'old_seven_bot' })
    p.forget('7')
    const target = p.target('7')
    await tick()
    lookups[0]!.resolve({ is_bot: true, username: LOOKED })
    await tick()
    p.learn({ id: 7, is_bot: true, username: WROTE })
    confirms[0]!.done.resolve()
    expect(await target).toBe(`@${WROTE}`)
    expect(confirms).toHaveLength(1)
  })

  test('of two lookups after forget, the one that comes second keeps the entry the first one’s confirm vouched for', async () => {
    const { p, lookups, confirms } = held()
    p.learn({ id: 7, is_bot: true, username: OLD })
    p.forget('7')
    const first = p.target('7')
    const second = p.target('7')
    await tick()
    expect(lookups).toHaveLength(2)
    lookups[0]!.resolve({ is_bot: true, username: NEW })
    await tick()
    confirms[0]!.done.resolve()
    expect(await first).toBe(`@${NEW}`)
    lookups[1]!.resolve({ is_bot: true, username: LOOKED })
    expect(await second).toBe(`@${NEW}`)
    expect(confirms).toHaveLength(1)
    expect(await p.target('7')).toBe(`@${NEW}`)
  })

  test('a lookup error after forget keeps its usual wording', async () => {
    const p = createPeers(async () => { throw new Error('Bad Request: member not found') }, async () => {})
    p.learn({ id: 7, is_bot: true, username: 'old_seven_bot' })
    p.forget('7')
    expect(await failsWith(p.target('7'))).toBe('could not tell whether chat 7 is a bot: Bad Request: member not found')
    expect(p.isBot('7')).toBe(true)
  })
})
