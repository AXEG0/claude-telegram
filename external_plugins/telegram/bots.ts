// Other bots on the allowlist. With bot-to-bot communication on for both bots
// (Bot API 10.0), Telegram delivers a private message from one bot to another
// when sendMessage names the receiving bot by its @username. Sent to the bot's
// numeric id before a message by @username has passed between the two, it is
// accepted and never arrives. So the reply tool, which gets the numeric
// chat_id Claude passes back from the inbound tag, sends to a bot by its
// @username, and a notice of the plugin's own that would go to a bot's chat
// goes to the owner chat instead.
//
// Whether a chat is a bot's comes from Telegram's own is_bot: on the sender of
// a message the access check let through, or, for a private chat not heard
// from since the server started, on the user getChatMember returns for it.
// getChat returns a bot's username but no is_bot.
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
}

// lookup asks Telegram about a private chat's user, such as with
// getChatMember(id, id).
export function createPeers(lookup: (userId: string) => Promise<Peer>): Peers {
  const known = new Map<string, Peer>()
  const peer = (user: { is_bot: boolean; username?: string }): Peer =>
    ({ is_bot: user.is_bot === true, ...(user.username ? { username: user.username } : {}) })
  return {
    learn(user) {
      known.set(String(user.id), peer(user))
    },
    isBot(chatId) {
      return known.get(chatId)?.is_bot === true
    },
    async target(chatId) {
      // A user's private chat has the user's id, a positive number; a group's
      // id is negative.
      if (!/^\d+$/.test(chatId)) return chatId
      let p = known.get(chatId)
      if (!p) {
        try {
          p = peer(await lookup(chatId))
        } catch (err) {
          throw new Error(`could not tell whether chat ${chatId} is a bot: ${err instanceof Error ? err.message : err}`)
        }
        known.set(chatId, p)
      }
      if (!p.is_bot) return chatId
      if (!p.username) throw new Error(`bot ${chatId} has no username to send to`)
      return `@${p.username}`
    },
  }
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
