// Never contact Telegram in subprocess tests, even if the shell has a token.
import { mock } from 'bun:test'
import { appendFileSync, existsSync, readFileSync } from 'fs'
import * as grammy from 'grammy'

let deliveredInbound = false

const fakeFetch = (async (url: string | URL | Request, options?: RequestInit) => {
  const method = String(url).split('/').pop()!
  appendFileSync(process.env.TELEGRAM_TEST_API_LOG!, JSON.stringify({
    pid: process.pid, method, payload: JSON.parse(String(options?.body ?? '{}')),
  }) + '\n')
  let result: unknown = true
  if (method === 'getMe') result = { id: 123, is_bot: true, first_name: 'Test', username: 'test_bot' }
  if (method === 'sendMessage') result = { message_id: 42, date: 0, chat: { id: 1, type: 'private' } }
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
