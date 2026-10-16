// Other bots on the allowlist. With bot-to-bot communication on for both bots
// (Bot API 10.0), Telegram delivers a private message from one bot to another
// when sendMessage names the receiving bot by its @username. Sent to the bot's
// numeric id before a message by @username has passed between the two, it is
// accepted and never arrives. So the reply tool, which gets the numeric
// chat_id Claude passes back from the inbound tag, sends to a bot by its
// @username, and a notice of the plugin's own that would go to a bot's chat
// goes to the owner chat instead.
//
// The receiving plugin hands Claude a message's text, caption or media. A
// rich message carries none of them, so a reply or an edit to a bot goes
// plain, with the text as Claude wrote it, whatever format Claude asked for.
//
// Whether a chat is a bot's comes from Telegram's own is_bot: on the sender of
// a message the access check let through, or, for a private chat not heard
// from since the server started, on the user getChatMember returns for it.
// getChat returns a bot's username but no is_bot.
//
// For a bot that has never written to this one, Telegram answers
// getChatMember with "chat not found". The owner adds such a bot in the
// terminal with its id and its username (botUsernames in access.json), and
// the lookup uses the username only to open the chat: getChat("@username")
// must return the allowlisted id, then getChatMember must describe a bot, and
// the send goes to the username Telegram gives, once getChat by that username
// returns the allowlisted id too. Identity stays on the numeric id: a check
// that fails sends nothing.
//
// After each message of a reply to a bot, the reply tool compares the chat
// Telegram says the message went to with the bot's id. On a mismatch it calls
// forget, and the next message to that chat goes only once getChat confirms
// the username Telegram gives for it.
//
// This file carries no dependencies beyond Node's.

export type Peer = { is_bot: boolean; username?: string }

export type Peers = {
  // The sender of a message the access check let through.
  learn(user: { id: number; is_bot: boolean; username?: string }): void
  // Whether the chat is a bot's, from what the server has heard since it started.
  isBot(chatId: string): boolean
  // Where a message to the chat goes: a bot's @username, or else the chat id.
  target(chatId: string): Promise<string>
  // Whether the chat is a bot's, asking Telegram about a private chat not
  // heard from.
  botChat(chatId: string): Promise<boolean>
  // A message to the chat went elsewhere. isBot and botChat keep answering
  // from the entry kept, and the next target asks Telegram again and keeps
  // the answer only once confirm vouches for its username.
  forget(chatId: string): void
}

// An error whose text is final: it goes to Claude as written, without the
// "could not tell whether chat <id> is a bot" a failed lookup gets.
export class PeerError extends Error {}

// A chat id the outbound tools take: numeric, without a leading zero.
export const CHAT_ID = /^-?[1-9]\d*$/
// A private chat's id, the user's own: positive.
const USER_ID = /^[1-9]\d*$/
// A bot's username: 5 to 32 Latin letters, digits and underscores, ending in
// "bot" in any case (Telegram's rule).
export const BOT_USERNAME = /^[A-Za-z0-9_]{2,29}bot$/i

// Whether an allowFrom list holds the id. Only an array counts, matched by
// element, so a string or an object admits nobody.
export function listed(list: unknown, id: unknown): boolean {
  return Array.isArray(list) && list.some(entry => entry === id)
}

// A JSON object: not null and not an array.
export function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A failed Bot API call: its method, with Telegram's error code and
// description, which keep a 429's retry figure. It never carries the call's
// arguments.
function failure(method: string, err: unknown): string {
  const e = err as { error_code?: unknown; description?: unknown } | undefined
  if (e && typeof e.error_code === 'number' && typeof e.description === 'string') {
    return `${method} failed (${e.error_code}: ${e.description})`
  }
  return `${method} failed: ${err instanceof Error ? err.message : String(err)}`
}

export type Confirm = (chatId: string, username: string) => Promise<void>

// Checks that a username Telegram gave for a chat leads back to that chat:
// getChat("@username") must return the chat's id. An error names the id
// Telegram returned and never the username.
export function createConfirm(getChat: (chatId: string) => Promise<{ id: number | string }>): Confirm {
  return async (chatId, username) => {
    let chat: { id: number | string }
    try {
      chat = await getChat(`@${username}`)
    } catch (err) {
      throw new PeerError(`could not check the username Telegram gives for ${chatId}: ${failure('getChat', err)}`)
    }
    if (String(chat.id) !== chatId) {
      throw new PeerError(`the username Telegram gives for ${chatId} is chat ${chat.id}, not ${chatId}`)
    }
  }
}

// The lookup createPeers takes: getChatMember(id, id), and, when Telegram
// refuses it for a bot the owner added with its username, the chat opened by
// that username. access returns allowFrom and botUsernames as access.json
// holds them at that moment.
export function createBotLookup(opts: {
  getChatMember: (userId: string) => Promise<Peer>
  getChat: (chatId: string) => Promise<{ id: number | string }>
  access: () => { allowFrom: unknown; botUsernames: unknown }
  log: (line: string) => void
}): (userId: string) => Promise<Peer> {
  const confirm = createConfirm(opts.getChat)

  // The username the owner stored for the bot, or else the refusal itself.
  function stored(userId: string, refused: unknown): string {
    // Flood control fails the reply as it is, retry figure included.
    if ((refused as { parameters?: { retry_after?: unknown } } | undefined)?.parameters?.retry_after !== undefined) throw refused
    if (!USER_ID.test(userId)) throw refused
    const { allowFrom, botUsernames } = opts.access()
    if (!listed(allowFrom, userId)) throw refused
    if (!plainObject(botUsernames) || !Object.hasOwn(botUsernames, userId)) throw refused
    const name = botUsernames[userId]
    if (typeof name !== 'string' || !BOT_USERNAME.test(name)) {
      throw new PeerError(`botUsernames entry for ${userId} is not a bot username`)
    }
    return name
  }

  return async userId => {
    let refused: unknown
    try {
      return await opts.getChatMember(userId)
    } catch (err) {
      refused = err
    }
    const name = stored(userId, refused)
    let chat: { id: number | string }
    try {
      chat = await opts.getChat(`@${name}`)
    } catch (err) {
      throw new PeerError(`could not open chat ${userId} by @${name}: ${failure('getChat', err)}`)
    }
    if (String(chat.id) !== userId) throw new PeerError(`@${name} is chat ${chat.id}, not ${userId}`)
    opts.log(`opened chat ${userId} by @${name}`)
    let user: Peer
    try {
      user = await opts.getChatMember(userId)
    } catch (err) {
      throw new PeerError(`chat ${userId} opened by @${name}, but ${failure('getChatMember', err)}`)
    }
    if (user.is_bot !== true) throw new PeerError(`chat ${userId} is not a bot, so nothing goes to @${name}`)
    if (!user.username) throw new PeerError(`bot ${userId} has no username to send to`)
    // The send goes to the username Telegram gives, so it must lead back too.
    if (user.username.toLowerCase() !== name.toLowerCase()) await confirm(userId, user.username)
    return user
  }
}

// lookup asks Telegram about a private chat's user, such as with
// getChatMember(id, id); confirm checks the username a lookup gives for a
// forgotten chat before the answer is kept.
export function createPeers(lookup: (userId: string) => Promise<Peer>, confirm?: Confirm): Peers {
  const known = new Map<string, Peer>()
  // Chats whose message went elsewhere since the entry was kept.
  const forgotten = new Set<string>()
  // When learn last set a chat's entry, and when forget last ran for it.
  let clock = 0
  const learnedAt = new Map<string, number>()
  const forgotAt = new Map<string, number>()
  const peer = (user: { is_bot: boolean; username?: string }): Peer =>
    ({ is_bot: user.is_bot === true, ...(user.username ? { username: user.username } : {}) })

  async function ask(chatId: string): Promise<Peer> {
    try {
      return peer(await lookup(chatId))
    } catch (err) {
      if (err instanceof PeerError) throw err
      throw new Error(`could not tell whether chat ${chatId} is a bot: ${err instanceof Error ? err.message : err}`)
    }
  }

  // The entry that stands once a lookup started at `started` answers.
  // Whether the chat is forgotten is read now, not when the lookup started.
  async function keep(chatId: string, answer: Peer, started: number, startedForgotten: boolean): Promise<Peer> {
    for (;;) {
      if (!forgotten.has(chatId)) {
        // A message from the chat since the lookup started vouches for its
        // own entry, which the answer never replaces; so does a confirm that
        // passed for another lookup since the chat was forgotten, whether this
        // lookup started before that forget or after it.
        const entry = known.get(chatId)
        if (entry && (startedForgotten || (learnedAt.get(chatId) ?? 0) > started || (forgotAt.get(chatId) ?? 0) > started)) return entry
        known.set(chatId, answer)
        return answer
      }
      // The forgotten entry stays unless the answer passes confirm.
      if (!answer.is_bot) throw new PeerError(`Telegram no longer describes chat ${chatId} as a bot`)
      if (!answer.username) throw new PeerError(`bot ${chatId} has no username to send to`)
      if (!confirm) throw new PeerError(`bot ${chatId} needs its username checked and no check was given`)
      const checking = clock
      await confirm(chatId, answer.username)
      // A forget or a message from the chat while confirm ran: decide again.
      if ((forgotAt.get(chatId) ?? 0) > checking || (learnedAt.get(chatId) ?? 0) > checking) continue
      known.set(chatId, answer)
      forgotten.delete(chatId)
      return answer
    }
  }

  // The private chat's user, or undefined for a group.
  async function peerOf(chatId: string): Promise<Peer | undefined> {
    // A user's private chat has the user's id, a positive number; a group's
    // id is negative.
    if (!/^\d+$/.test(chatId)) return undefined
    const entry = known.get(chatId)
    if (entry && !forgotten.has(chatId)) return entry
    const started = clock
    const startedForgotten = forgotten.has(chatId)
    return keep(chatId, await ask(chatId), started, startedForgotten)
  }

  return {
    learn(user) {
      const id = String(user.id)
      known.set(id, peer(user))
      forgotten.delete(id)
      learnedAt.set(id, ++clock)
    },
    isBot(chatId) {
      return known.get(chatId)?.is_bot === true
    },
    async target(chatId) {
      const p = await peerOf(chatId)
      if (!p?.is_bot) return chatId
      if (!p.username) throw new Error(`bot ${chatId} has no username to send to`)
      return `@${p.username}`
    },
    async botChat(chatId) {
      // A forgotten entry still answers, with no call.
      const entry = known.get(chatId)
      if (entry) return entry.is_bot
      return (await peerOf(chatId))?.is_bot === true
    },
    forget(chatId) {
      forgotten.add(chatId)
      forgotAt.set(chatId, ++clock)
    },
  }
}

// How a reply or an edit in the format Claude asked for goes to a chat: as
// asked to a person or a group, and as plain text, unparsed, to a bot.
export type Style = 'rich' | 'markdownv2' | 'text'
export function sendStyle(format: string, toBot: boolean): Style {
  if (toBot) return 'text'
  return format === 'rich' || format === 'markdownv2' ? format : 'text'
}

// The chat a notice of the plugin's own goes to: the chat itself, or the owner
// chat when the chat is a bot's. With no owner chat, a bot's notice goes nowhere.
export function noticeChat(
  chatId: string | undefined,
  peers: Pick<Peers, 'isBot'>,
  owner: string | undefined,
): string | undefined {
  if (chatId === undefined) return undefined
  return peers.isBot(chatId) ? owner : chatId
}
