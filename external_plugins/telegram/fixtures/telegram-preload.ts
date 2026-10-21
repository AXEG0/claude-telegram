// Never contact Telegram in subprocess tests, even if the shell has a token.
import { mock } from 'bun:test'
import { appendFileSync, existsSync, readFileSync, renameSync } from 'fs'
import * as grammy from 'grammy'

// A file upload goes as a multipart stream; its fields are logged as text and
// each file as its name.
async function payloadOf(options?: RequestInit): Promise<Record<string, unknown>> {
  const body = options?.body
  if (body == null) return {}
  if (typeof body === 'string') return JSON.parse(body)
  const chunks: Buffer[] = []
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
  const type = new Headers(options!.headers).get('content-type') ?? ''
  const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': type } }).formData()
  const out: Record<string, unknown> = {}
  for (const [key, value] of form) out[key] = typeof value === 'string' ? value : `file:${value.name}`
  return out
}

// The text Telegram would return in a chat's or a user's own fields (first
// name, bio, description), so a test can search every error for it.
const MARKER = 'text-telegram-returned'

type User = { id: number; is_bot: boolean; first_name?: string; username?: string }

// TELEGRAM_TEST_USERS maps a user id to the user getChatMember returns for
// that private chat, or to null for a lookup Telegram refuses; any other id is
// a person with no username.
const users = JSON.parse(process.env.TELEGRAM_TEST_USERS || '{}') as Record<string, User | null>

// TELEGRAM_TEST_CHATS shapes what Telegram answers about chats, by user id or
// username:
// - unopened: users whose getChatMember answers "chat not found" until a
//   getChat by a username they hold.
// - closed: users whose getChatMember answers "chat not found" even after that.
// - flood: users whose getChatMember answers 429, with retry_after in seconds.
// - second: a user's second username, which getChat and the sends resolve to
//   the user, while getChatMember gives the first.
// - refuse: usernames getChat refuses as "chat not found".
// - redirect: a username that answers another chat, in the sends and in
//   getChat, from its `from`-th send onward (1 or unset: from the start);
//   messages sent to it get their own ids from `ids` on.
// - hold: the answer to the `send`-th send of the process waits `ms`.
// - ids: every message the process sends to a numeric chat gets its own
//   id, from `ids` on; unset, every message gets the same id, as before.
type Chats = {
  unopened?: number[]
  closed?: number[]
  flood?: Record<string, number>
  second?: Record<string, string>
  refuse?: string[]
  redirect?: { username: string; to: number; from?: number; ids?: number }
  hold?: { send: number; ms: number }
  ids?: number
}
const chats = JSON.parse(process.env.TELEGRAM_TEST_CHATS || '{}') as Chats
let nextId = chats.ids

// TELEGRAM_TEST_RULES shapes Telegram's answers to calls: each rule matches a
// call by method, by `has` (texts all in the call's payload as JSON), and by
// `markup` (whether the call carries a keyboard), for its first `times`
// matches (every match, if unset), after letting its first `skip` matches
// pass as usual. A matched call's answer waits `holdMs`,
// then is `error` if set, else the usual answer. The log marks a call a rule
// refuses with `refused`.
type Rule = {
  method: string | string[]
  has?: string | string[]
  markup?: boolean
  skip?: number
  times?: number
  holdMs?: number
  error?: { error_code: number; description: string; parameters?: object }
}
const rules = (JSON.parse(process.env.TELEGRAM_TEST_RULES || '[]') as Rule[]).map(rule => ({ rule, seen: 0, used: 0 }))
function ruleFor(method: string, payload: Record<string, unknown>): Rule | undefined {
  const text = JSON.stringify(payload)
  for (const r of rules) {
    const { rule } = r
    if (![rule.method].flat().includes(method)) continue
    if (rule.has !== undefined && ![rule.has].flat().every(h => text.includes(h))) continue
    if (rule.markup !== undefined && (payload.reply_markup !== undefined) !== rule.markup) continue
    if (rule.times !== undefined && r.used >= rule.times) continue
    if (r.seen++ < (rule.skip ?? 0)) continue
    r.used++
    return rule
  }
  return undefined
}
let rounds = 0

// The senders of every update delivered from TELEGRAM_TEST_INBOUND.
const senders = new Map<number, User>()
// Unopened users a getChat by their username has opened.
const opened = new Set<number>()
let sends = 0
let redirectSends = 0
let redirectIds = 0

const lower = (s: string) => s.toLowerCase()
const redirect = chats.redirect && { ...chats.redirect, username: lower(chats.redirect.username) }
// Whether the redirected username answers the other chat by now.
const redirected = () => redirect !== undefined && redirectSends >= Math.max(1, redirect.from ?? 1)

// The user holding a username, in any case, among the test's users and the
// senders delivered so far.
function holder(username: string): User | undefined {
  const name = lower(username)
  for (const user of [...Object.values(users), ...senders.values()]) {
    if (!user) continue
    if (user.username && lower(user.username) === name) return user
    if (lower(chats.second?.[String(user.id)] ?? '') === name) return user
  }
  return undefined
}

const notFound = { ok: false, error_code: 400, description: 'Bad Request: chat not found' }

function member(userId: number): object {
  const flood = chats.flood?.[String(userId)]
  if (flood !== undefined) {
    return { ok: false, error_code: 429, description: `Too Many Requests: retry after ${flood}`, parameters: { retry_after: flood } }
  }
  if (chats.closed?.includes(userId)) return notFound
  if (chats.unopened?.includes(userId) && !opened.has(userId)) return notFound
  if (users[userId] === null) return { ok: false, error_code: 400, description: 'Bad Request: member not found' }
  const user = users[userId] ?? senders.get(userId) ?? { id: userId, is_bot: false }
  return { ok: true, result: { status: 'member', user: { ...user, first_name: MARKER } } }
}

function chat(chatId: unknown): object {
  const name = String(chatId)
  if (!name.startsWith('@')) return notFound
  const username = name.slice(1)
  if (chats.refuse?.some(r => lower(r) === lower(username))) return notFound
  const elsewhere = redirect && lower(username) === redirect.username && ((redirect.from ?? 1) <= 1 || redirected())
  const id = elsewhere ? redirect!.to : holder(username)?.id
  if (id === undefined) return notFound
  opened.add(id)
  return { ok: true, result: { id, type: 'private', username, first_name: MARKER, bio: MARKER, description: MARKER } }
}

// The chat a send went to: a numeric chat_id as that number, a username as
// its holder's id.
function recipient(chatId: unknown): { id: number; message_id: number } | undefined {
  const to = String(chatId)
  if (!to.startsWith('@')) return { id: Number(to), message_id: 42 }
  if (redirect && lower(to.slice(1)) === redirect.username) {
    redirectSends++
    const message_id = redirect.ids === undefined ? 42 : redirect.ids + redirectIds++
    if (redirected()) return { id: redirect.to, message_id }
    const user = holder(to.slice(1))
    return user && { id: user.id, message_id }
  }
  const user = holder(to.slice(1))
  return user && { id: user.id, message_id: 42 }
}

function remember(updates: unknown[]): void {
  for (const u of updates as Record<string, { from?: User } | undefined>[]) {
    for (const item of [u.message, u.edited_message, u.callback_query]) {
      if (item?.from) senders.set(item.from.id, item.from)
    }
  }
}

const json = (body: object) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

const SENDS = ['sendMessage', 'sendPhoto', 'sendDocument', 'sendRichMessage']

const fakeFetch = (async (url: string | URL | Request, options?: RequestInit) => {
  const method = String(url).split('/').pop()!
  const payload = await payloadOf(options)
  // A send is logged with the id it gets, unless a rule refuses it, and every
  // call with when it came.
  const n = SENDS.includes(method) ? ++sends : 0
  const rule = ruleFor(method, payload)
  const to = n && !rule?.error ? recipient(payload.chat_id) : undefined
  if (to && nextId !== undefined && !String(payload.chat_id).startsWith('@')) to.message_id = nextId++
  appendFileSync(process.env.TELEGRAM_TEST_API_LOG!, JSON.stringify({
    pid: process.pid, method, payload, at: Date.now(),
    ...(to ? { message_id: to.message_id } : {}),
    ...(rule?.error ? { refused: rule.error.description } : {}),
  }) + '\n')
  if (rule?.holdMs) await Bun.sleep(rule.holdMs)
  if (rule?.error) return json({ ok: false, ...rule.error })
  let result: unknown = true
  if (method === 'getMe') result = { id: 123, is_bot: true, first_name: 'Test', username: 'test_bot' }
  if (n) {
    if (chats.hold?.send === n) await Bun.sleep(chats.hold.ms)
    if (!to) return json(notFound)
    result = { message_id: to.message_id, date: 0, chat: { id: to.id, type: to.id < 0 ? 'supergroup' : 'private' } }
  }
  if (method === 'getChatMember') return json(member(Number(payload.user_id)))
  if (method === 'getChat') return json(chat(payload.chat_id))
  if (method === 'getUpdates') {
    await Bun.sleep(25)
    result = []
    // Each round of updates the test writes is delivered once, then moved
    // aside, so the test can write the next.
    const inbound = process.env.TELEGRAM_TEST_INBOUND
    if (inbound && existsSync(inbound)) {
      try {
        const updates = JSON.parse(readFileSync(inbound, 'utf8'))
        renameSync(inbound, `${inbound}.${process.pid}.${++rounds}`)
        result = updates
        remember(updates as unknown[])
      } catch {}
    }
  }
  return json({ ok: true, result })
}) as unknown as typeof fetch

const RealBot = grammy.Bot
mock.module('grammy', () => ({
  ...grammy,
  Bot: class extends RealBot {
    constructor(token: string) { super(token, { client: { fetch: fakeFetch } }) }
  },
}))
