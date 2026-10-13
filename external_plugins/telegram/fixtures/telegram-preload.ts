// Never contact Telegram in subprocess tests, even if the shell has a token.
import { mock } from 'bun:test'
import { appendFileSync, existsSync, readFileSync } from 'fs'
import * as grammy from 'grammy'

let deliveredInbound = false

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

// TELEGRAM_TEST_USERS maps a user id to the user getChatMember returns for
// that private chat, or to null for a lookup Telegram refuses; any other id is
// a person with no username.
function member(userId: number): { ok: boolean; result?: unknown; error_code?: number; description?: string } {
  const users = JSON.parse(process.env.TELEGRAM_TEST_USERS || '{}') as Record<string, unknown>
  if (users[userId] === null) return { ok: false, error_code: 400, description: 'Bad Request: member not found' }
  return { ok: true, result: { status: 'member', user: users[userId] ?? { id: userId, is_bot: false, first_name: 'Person' } } }
}

const fakeFetch = (async (url: string | URL | Request, options?: RequestInit) => {
  const method = String(url).split('/').pop()!
  const payload = await payloadOf(options)
  appendFileSync(process.env.TELEGRAM_TEST_API_LOG!, JSON.stringify({ pid: process.pid, method, payload }) + '\n')
  let result: unknown = true
  if (method === 'getMe') result = { id: 123, is_bot: true, first_name: 'Test', username: 'test_bot' }
  if (['sendMessage', 'sendPhoto', 'sendDocument', 'sendRichMessage'].includes(method)) {
    result = { message_id: 42, date: 0, chat: { id: 1, type: 'private' } }
  }
  if (method === 'getChatMember') {
    return new Response(JSON.stringify(member(Number(payload.user_id))), { headers: { 'content-type': 'application/json' } })
  }
  if (method === 'getUpdates') {
    await Bun.sleep(25)
    result = []
    const inbound = process.env.TELEGRAM_TEST_INBOUND
    if (inbound && !deliveredInbound && existsSync(inbound)) {
      result = JSON.parse(readFileSync(inbound, 'utf8'))
      deliveredInbound = true
    }
  }
  return new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } })
}) as unknown as typeof fetch

const RealBot = grammy.Bot
mock.module('grammy', () => ({
  ...grammy,
  Bot: class extends RealBot {
    constructor(token: string) { super(token, { client: { fetch: fakeFetch } }) }
  },
}))
