// Telegram replayed for the live check (live-check.ts), offline: each Bot API
// call the check makes is answered from Telegram's own answers in the check's
// last run against Telegram itself (live-check-telegram.json, by case name),
// and no call leaves the process. live-check.test.ts loads it as the preload
// of a live-check.ts run, whose stand-in side runs as it always does.
// LIVE_CHECK_REPLAY_CASES holds the check's cases in their order, each as its
// name, method and `on`. A case's call is answered with Telegram's answer to
// that case, the message an edit case edits with a message as Telegram sends
// one, and each delete with success; a call out of that order fails the run.
// grammY's client calls the fetch its Bot is given, not globalThis.fetch, so
// the replay takes the place of that fetch, as telegram-preload.ts does, under
// an API root on a closed local port, and globalThis.fetch refuses every call.
import { mock } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import * as grammy from 'grammy'
import type { Seen } from '../live-check.ts'

type Case = { name: string; method: string; on?: 'text' | 'file' }
const answers = JSON.parse(readFileSync(join(import.meta.dir, 'live-check-telegram.json'), 'utf8')) as Record<string, Seen>
const cases = JSON.parse(process.env.LIVE_CHECK_REPLAY_CASES ?? '[]') as Case[]
const API_ROOT = 'http://127.0.0.1:9'

const answer = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let id = 0
const message = (fields: object) => ({ message_id: ++id, date: 0, chat: { id: 5, type: 'private' }, ...fields })
const document = { file_id: 'replayed', file_unique_id: 'replayed', file_name: 'live-check.txt' }
const BASE = 'the message before its edit'

// The case whose call comes next, and whether the message it edits is sent.
let next = 0
let based = false
const replayFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input)
  if (!url.startsWith(`${API_ROOT}/bot`)) throw new TypeError(`the replay refuses a call to ${url}`)
  const method = url.slice(url.lastIndexOf('/') + 1)
  // An upload's stream is read to its end, as Telegram reads it.
  const body = init?.body
  if (body != null && typeof body !== 'string') for await (const _ of body as unknown as AsyncIterable<Uint8Array>) {}
  if (method === 'deleteMessage') return answer({ ok: true, result: true })
  const c = cases[next]
  if (!c) throw new TypeError(`the replay has no case left for ${method}`)
  const seen = answers[c.name]
  if (!seen) throw new TypeError(`the replay holds no answer of Telegram's to ${c.name}`)
  if (c.method.startsWith('edit') && !based) {
    const ofText = c.method === 'editMessageText' ? c.on !== 'file' : c.on === 'text'
    const want = ofText ? 'sendMessage' : 'sendDocument'
    if (method !== want) throw new TypeError(`case ${c.name}: the replay expects the ${want} of the message it edits, not ${method}`)
    based = true
    return answer({ ok: true, result: message(ofText ? { text: BASE } : { document, caption: BASE }) })
  }
  if (method !== c.method) throw new TypeError(`case ${c.name}: the replay expects ${c.method}, not ${method}`)
  next++
  based = false
  if ('refused' in seen) return answer({ ok: false, error_code: 400, description: seen.refused }, 400)
  if ('text' in seen) return answer({ ok: true, result: message(seen.text === null ? {} : { text: seen.text }) })
  if ('captions' in seen) {
    return answer({ ok: true, result: seen.captions.map(caption => message({ document, media_group_id: 'replayed', ...(caption === null ? {} : { caption }) })) })
  }
  if ('caption' in seen) return answer({ ok: true, result: message({ document, ...(seen.caption === null ? {} : { caption: seen.caption }) }) })
  return answer({ ok: true, result: message({ text: 'edited' }) })
}) as unknown as typeof fetch

globalThis.fetch = (async (input: string | URL | Request) => {
  throw new TypeError(`the replay refuses a fetch of ${input instanceof Request ? input.url : String(input)}`)
}) as unknown as typeof fetch

const RealBot = grammy.Bot
mock.module('grammy', () => ({
  ...grammy,
  Bot: class extends RealBot {
    constructor(token: string) {
      super(token, { client: { fetch: replayFetch, apiRoot: API_ROOT } })
    }
  },
}))
