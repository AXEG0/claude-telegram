// Never contact Telegram in subprocess tests, even if the shell has a token.
import { mock } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as grammy from 'grammy'

// A file upload goes as a multipart stream; its fields are logged as text and
// each file as its name.
async function payloadOf(options?: RequestInit): Promise<Record<string, unknown>> {
  return attached(await fieldsOf(options))
}
async function fieldsOf(options?: RequestInit): Promise<Record<string, unknown>> {
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
// grammY sends each file as a part of its own, named in the field that
// carries it as attach://<part>, an album's media included. The log shows the
// file in that field, and no part of its own.
function attached(form: Record<string, unknown>): Record<string, unknown> {
  const parts = new Set<string>()
  const file = (v: unknown) => {
    if (typeof v !== 'string' || !v.startsWith('attach://')) return v
    const part = v.slice('attach://'.length)
    parts.add(part)
    return form[part]
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(form)) out[key] = file(value)
  if (typeof form.media === 'string') {
    const media = JSON.parse(form.media) as Record<string, unknown> | Record<string, unknown>[]
    out.media = Array.isArray(media) ? media.map(m => ({ ...m, media: file(m.media) })) : { ...media, media: file(media.media) }
  }
  for (const part of parts) delete out[part]
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
// An album (sendMediaGroup) is one send: it counts once for `redirect`'s
// `from` and for `hold`. Its first message gets an id as any send does, and
// each other message the next one where ids are counted, else the same id.
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
// pass as usual. A matched call reaches the fake `preMs` late, so a call
// sent after it can arrive first; its answer waits `holdMs`, then is `error`
// if set, else the usual answer, unless `drop` loses the connection after the
// fake applied the call and before it answers. The log marks a call a rule
// refuses with `refused`.
type Rule = {
  method: string | string[]
  has?: string | string[]
  markup?: boolean
  skip?: number
  times?: number
  preMs?: number
  holdMs?: number
  drop?: boolean
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
// The id of an album's next message: the next of the counter that numbered
// its first, or the first's own where none counts.
function nextOf(chatId: unknown, first: number): number {
  const to = String(chatId)
  if (!to.startsWith('@')) return nextId === undefined ? first : nextId++
  if (redirect && lower(to.slice(1)) === redirect.username && redirect.ids !== undefined) return redirect.ids + redirectIds++
  return first
}

function remember(updates: unknown[]): void {
  for (const u of updates as Record<string, { from?: User } | undefined>[]) {
    for (const item of [u.message, u.edited_message, u.callback_query]) {
      if (item?.from) senders.set(item.from.id, item.from)
    }
  }
}

const json = (body: object) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

// TELEGRAM_TEST_LONG_POLL=1 holds each long poll (a getUpdates carrying a
// timeout, which grammY's own closing getUpdates lacks) the way Telegram
// does: until the test writes a round of updates, or the poll's timeout. The
// hold races the request's abort signal, as a real fetch would: an aborted
// poll rejects, is logged as aborted and reads no round.
const LONG_POLL = process.env.TELEGRAM_TEST_LONG_POLL === '1'
async function holdPoll(payload: Record<string, unknown>, signal: AbortSignal | null | undefined): Promise<void> {
  const inbound = process.env.TELEGRAM_TEST_INBOUND
  const end = Date.now() + Number(payload.timeout) * 1000
  while (!(inbound && existsSync(inbound)) && Date.now() < end) {
    if (signal?.aborted) break
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 10)
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }
  if (signal?.aborted) {
    appendFileSync(process.env.TELEGRAM_TEST_API_LOG!, JSON.stringify({ pid: process.pid, method: 'getUpdates', payload, at: Date.now(), aborted: true }) + '\n')
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
  }
}

const SENDS = ['sendMessage', 'sendPhoto', 'sendDocument', 'sendRichMessage', 'sendMediaGroup']

// Telegram trims spaces and line breaks from both ends of a text or caption,
// and refuses a text message, or a text edit, with nothing left.
const trimmed = (text: string) => text.replace(/^[ \n]+|[ \n]+$/g, '')
const EMPTY_TEXT = { error_code: 400, description: 'Bad Request: message text is empty' }
const emptyText = (method: string, payload: Record<string, unknown>) =>
  (method === 'sendMessage' || method === 'editMessageText') && typeof payload.text === 'string' && trimmed(payload.text) === ''

// The test's own Telegram identity: what getMe answers, and the sender of
// every update the bridge delivers.
const ME = { id: 123, is_bot: true, first_name: 'Test', username: 'test_bot' }

// TELEGRAM_TEST_BRIDGE = { dir, username } hands another server what this one
// sends to @username, as Telegram hands it to the receiving bot: each send the
// fake takes to that username is written to dir, at the moment it is logged,
// as one update per message, from ME in ME's private chat. A text or caption
// arrives trimmed as Telegram trims it, a file as a document or a photo named
// file-of-<its name>, an album's messages under one media_group_id, and a
// reply target as reply_to_message. The bridge numbers the messages from 1.
// TELEGRAM_TEST_BRIDGE = { dir } without a username delivers those updates in
// order to this server's getUpdates, each once.
const bridge = process.env.TELEGRAM_TEST_BRIDGE ? JSON.parse(process.env.TELEGRAM_TEST_BRIDGE) as { dir: string; username?: string } : undefined
let bridged = 0
function bridgeSend(method: string, payload: Record<string, unknown>): void {
  if (!bridge?.username || lower(String(payload.chat_id)) !== `@${lower(bridge.username)}`) return
  // A file upload carries its fields as text, an object field as JSON.
  const field = (v: unknown) => typeof v === 'string' ? JSON.parse(v) : v
  const replyTo = (field(payload.reply_parameters) as { message_id?: number } | undefined)?.message_id
  const chat = { id: ME.id, type: 'private', first_name: ME.first_name, username: ME.username }
  const file = (type: unknown, media: unknown, caption: unknown, n: number) => {
    const name = String(media).replace(/^file:/, '')
    const kept = typeof caption === 'string' ? trimmed(caption) : ''
    return {
      ...(type === 'photo'
        ? { photo: [{ file_id: `file-of-${name}`, file_unique_id: `u${n}`, width: 1, height: 1 }] }
        : { document: { file_id: `file-of-${name}`, file_unique_id: `u${n}`, file_name: name } }),
      ...(kept ? { caption: kept } : {}),
    }
  }
  const group = `album-of-${bridged + 1}`
  const items: ((n: number) => object)[] =
    method === 'sendMessage' ? [() => ({ text: trimmed(String(payload.text)) })]
    : method === 'sendDocument' ? [n => file('document', payload.document, payload.caption, n)]
    : method === 'sendPhoto' ? [n => file('photo', payload.photo, payload.caption, n)]
    : method === 'sendMediaGroup' ? (payload.media as Record<string, unknown>[]).map(m => (n: number) => ({ ...file(m.type, m.media, m.caption, n), media_group_id: group }))
    : []
  mkdirSync(bridge.dir, { recursive: true })
  for (const item of items) {
    const n = ++bridged
    const update = { update_id: 1000 + n, message: {
      message_id: n, date: Math.floor(Date.now() / 1000), from: ME, chat,
      ...(replyTo !== undefined ? { reply_to_message: { message_id: replyTo, date: 0, chat } } : {}),
      ...item(n),
    } }
    const path = join(bridge.dir, `${String(n).padStart(6, '0')}.json`)
    writeFileSync(`${path}.tmp`, JSON.stringify(update))
    renameSync(`${path}.tmp`, path)
  }
}
// The updates the bridge holds for this server, in order, each moved aside
// once read.
function bridgeUpdates(): unknown[] {
  if (!bridge || bridge.username || !existsSync(bridge.dir)) return []
  const out: unknown[] = []
  for (const name of readdirSync(bridge.dir).filter(f => /^\d+\.json$/.test(f)).sort()) {
    const file = join(bridge.dir, name)
    out.push(JSON.parse(readFileSync(file, 'utf8')))
    renameSync(file, `${file}.delivered`)
  }
  return out
}

const fakeFetch = (async (url: string | URL | Request, options?: RequestInit) => {
  const method = String(url).split('/').pop()!
  const payload = await payloadOf(options)
  // A send is logged with the id it gets, unless it is refused, and every
  // call with when it came.
  const n = SENDS.includes(method) ? ++sends : 0
  const rule = ruleFor(method, payload)
  const refusal = emptyText(method, payload) ? EMPTY_TEXT : rule?.error
  if (rule?.preMs) await Bun.sleep(rule.preMs)
  const to = n && !refusal ? recipient(payload.chat_id) : undefined
  if (to && nextId !== undefined && !String(payload.chat_id).startsWith('@')) to.message_id = nextId++
  const album = to && method === 'sendMediaGroup'
    ? [to.message_id, ...(payload.media as unknown[]).slice(1).map(() => nextOf(payload.chat_id, to.message_id))]
    : undefined
  appendFileSync(process.env.TELEGRAM_TEST_API_LOG!, JSON.stringify({
    pid: process.pid, method, payload, at: Date.now(),
    ...(to ? album ? { message_ids: album } : { message_id: to.message_id } : {}),
    ...(refusal ? { refused: refusal.description } : {}),
  }) + '\n')
  if (to) bridgeSend(method, payload)
  if (rule?.holdMs) await Bun.sleep(rule.holdMs)
  if (refusal) return json({ ok: false, ...refusal })
  if (rule?.drop) throw new TypeError('fetch failed: the connection was reset')
  let result: unknown = true
  if (method === 'getMe') result = ME
  if (n) {
    if (chats.hold?.send === n) await Bun.sleep(chats.hold.ms)
    if (!to) return json(notFound)
    const sent = (album ?? [to.message_id]).map(message_id => ({ message_id, date: 0, chat: { id: to.id, type: to.id < 0 ? 'supergroup' : 'private' } }))
    result = album ? sent : sent[0]
  }
  if (method === 'getChatMember') return json(member(Number(payload.user_id)))
  if (method === 'getChat') return json(chat(payload.chat_id))
  if (method === 'getUpdates') {
    if (LONG_POLL && payload.timeout !== undefined) await holdPoll(payload, options?.signal)
    else await Bun.sleep(25)
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
    const fromBridge = bridgeUpdates()
    if (fromBridge.length) {
      result = [...(result as unknown[]), ...fromBridge]
      remember(fromBridge)
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
