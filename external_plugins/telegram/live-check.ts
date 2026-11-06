#!/usr/bin/env bun
// The live check: every text and caption rule the tests' stand-in for
// Telegram (fixtures/telegram-preload.ts) keeps, run against Telegram itself
// and against the stand-in, naming each case where the two differ.
//
//   TELEGRAM_LIVE_CHECK_TOKEN=<bot token> bun live-check.ts --chat <chat id> [--pace <ms>]
//
// The token comes only from TELEGRAM_LIVE_CHECK_TOKEN and the chat only from
// --chat, both named by the person running it: without either it refuses
// before any call. Every case first runs through the stand-in, in a process
// of its own that never sees the token (fixtures/live-check-stand-in.ts), and
// then through Telegram: each message goes to the chat silently, and each
// message Telegram took is deleted as soon as its case is read; a run that
// stops partway deletes what it took before it stops. Calls to Telegram go
// --pace milliseconds apart, 1000 unless set, as Telegram asks a bot to send
// a chat at most about one message a second, and a 429 waits out its
// retry_after and sends the call again. It prints one line for each case, the
// stand-in's answer beside Telegram's where they differ, and never any part
// of the token. It exits 0 when every case agrees, 1 when any differs, and 2
// when it refused, could not run every case, or could not delete a message.
// It is no test file, so `bun test` never runs it, and CI has no token for it.
import { Bot, InputFile } from 'grammy'
import { spawnSync } from 'child_process'
import { join } from 'path'

type Method = 'sendMessage' | 'sendDocument' | 'sendMediaGroup' | 'editMessageText' | 'editMessageCaption'
// A case sends its value as a text, a document's caption or the first
// caption of an album of two documents, or edits a message to it: a text
// edit edits a text message, or a document with `on: 'file'`; a caption edit
// edits a captioned document, or a text message with `on: 'text'`.
export type Case = { name: string; method: Method; value: string; on?: 'text' | 'file' }
// What Telegram, or the stand-in, answered a case's call: a refusal and its
// description, or the text, the caption or each album member's caption it
// kept (null for none), or, for a text edit, that it took the edit.
export type Seen = { refused: string } | { text: string | null } | { caption: string | null } | { captions: (string | null)[] } | { edited: true }

const text = (name: string, value: string): Case => ({ name, method: 'sendMessage', value })
const caption = (name: string, value: string): Case => ({ name, method: 'sendDocument', value })
const album = (name: string, value: string): Case => ({ name, method: 'sendMediaGroup', value })
const textEdit = (name: string, value: string, on?: 'file'): Case => ({ name, method: 'editMessageText', value, ...(on ? { on } : {}) })
const captionEdit = (name: string, value: string, on?: 'text'): Case => ({ name, method: 'editMessageCaption', value, ...(on ? { on } : {}) })
const x = (n: number) => 'x'.repeat(n)
const lines = Array.from({ length: 25 }, () => 'l'.repeat(40)).join('\r\n')
// Each character a caption of nothing but it is checked with, by its name.
const ALONE: [string, string][] = [
  ['nbsp', '\u00a0'], ['u200b', '\u200b'], ['u0333', '\u0333'], ['u2000', '\u2000'], ['u2009', '\u2009'], ['u200a', '\u200a'],
  ['u200c', '\u200c'], ['u200d', '\u200d'], ['u200e', '\u200e'], ['u200f', '\u200f'], ['u202f', '\u202f'], ['u2800', '\u2800'],
  ['u3000', '\u3000'], ['ufeff', '\ufeff'], ['u2060', '\u2060'], ['nbsp-u200b', '\u00a0\u200b'], ['u1680', '\u1680'], ['u180e', '\u180e'],
  ['u2001', '\u2001'], ['u2002', '\u2002'], ['u2003', '\u2003'], ['u2004', '\u2004'], ['u2005', '\u2005'], ['u2006', '\u2006'],
  ['u2007', '\u2007'], ['u2008', '\u2008'], ['u205f', '\u205f'], ['ufffc', '\ufffc'], ['ue0000', '\u{e0000}'], ['ue0001', '\u{e0001}'],
  ['ue0020', '\u{e0020}'], ['ue0041', '\u{e0041}'], ['ue007f', '\u{e007f}'], ['ue0080', '\u{e0080}'],
]

// The stand-in's rules for a text: it trims spaces and line breaks from both
// ends of a text message, keeps the rest as sent, and refuses a text message,
// or a text edit, with nothing left; it refuses a text edit of a file and a
// caption edit of a text. Its rules for a caption: what it keeps of a
// caption, sent with a file, with an album's first file or as an edit, none
// when nothing is left, and its refusal of a caption over 1024 characters.
// Each case reads one of them at an edge Telegram may draw elsewhere.
export const CASES: Case[] = [
  text('text-ends', '  \n kept \n  '),
  text('text-inside', 'a \n b'),
  text('text-empty', ''),
  text('text-spaces-only', ' \n \n '),
  text('text-tab-ends', '\tx\t'),
  text('text-cr', 'a\rb'),
  text('text-control', 'a\x01b'),
  text('text-u2028', 'a\u2028b'),
  text('text-u0333', 'a\u0333b'),
  text('text-nbsp-ends', '\u00a0x\u00a0'),
  text('text-tabs-cr-only', ' \t\r '),
  text('text-nbsp-only', '\u00a0'),
  text('text-u200b-only', '\u200b'),
  textEdit('text-edit-ends', ' \n edited \n '),
  textEdit('text-edit-spaces-only', ' \n '),
  textEdit('text-edit-tabs-cr-only', ' \t\r '),
  textEdit('text-edit-of-file', 'edited', 'file'),
  captionEdit('caption-edit-of-text', 'edited', 'text'),
  caption('caption-ends', ' \n x \n '),
  caption('caption-inside', 'a \n b'),
  caption('caption-spaces-only', ' \n '),
  caption('caption-tab-ends', '\tx\t'),
  caption('caption-control-ends', '\x01x\x01'),
  caption('caption-x00', 'a\x00b'),
  caption('caption-x01', 'a\x01b'),
  caption('caption-x0b', 'a\x0bb'),
  caption('caption-x0c', 'a\x0cb'),
  caption('caption-x1f', 'a\x1fb'),
  caption('caption-x7f', 'a\x7fb'),
  caption('caption-lf', 'a\nb'),
  caption('caption-cr', 'a\rb'),
  caption('caption-u2027', 'a\u2027b'),
  caption('caption-u2028', 'a\u2028b'),
  caption('caption-u2029', 'a\u2029b'),
  caption('caption-u202a', 'a\u202ab'),
  caption('caption-u202b', 'a\u202bb'),
  caption('caption-u202e', 'a\u202eb'),
  caption('caption-u202f', 'a\u202fb'),
  caption('caption-u030a', 'a\u030ab'),
  caption('caption-u0333', 'a\u0333b'),
  caption('caption-u033f', 'a\u033fb'),
  caption('caption-u200b', 'a\u200bb'),
  caption('caption-nbsp-ends', '\u00a0x\u00a0'),
  caption('caption-tabs-cr-only', ' \t\r '),
  ...ALONE.map(([name, value]) => caption(`caption-only-${name}`, value)),
  caption('caption-1024-in-tabs', '\t' + x(1024) + '\t'),
  caption('caption-1024-and-cr', x(1024) + '\r'),
  caption('caption-1024-crlf-lines', lines),
  caption('caption-1024-emoji', '\u{1f600}'.repeat(1024)),
  caption('caption-1025-emoji', '\u{1f600}'.repeat(1025)),
  caption('caption-1025', x(1025)),
  caption('caption-nbsp-and-1024', '\u00a0' + x(1024)),
  album('album-tab-ends', '\tx\t'),
  album('album-1025', x(1025)),
  captionEdit('caption-edit-ends', ' \n edited \n '),
  captionEdit('caption-edit-tab-ends', '\tedited\t'),
  captionEdit('caption-edit-mixed', 'a\x00b\x0cc\u202ad\u202be\u030af\u0333g\u033fh\u2027i\u202fj\r'),
  captionEdit('caption-edit-tabs-cr-only', ' \t\r '),
  ...['nbsp', 'u200b', 'u0333', 'u2009', 'u200c', 'u202f', 'ufeff'].map(name =>
    captionEdit(`caption-edit-only-${name}`, ALONE.find(([n]) => n === name)![1])),
]

// The text or caption of the message an edit case edits, which no case's
// value is kept as, so no edit answers "message is not modified".
const BASE = 'the message before its edit'
const FILE = new TextEncoder().encode('A file the live check sends and deletes.\n')
const file = () => new InputFile(FILE, 'live-check.txt')

export type Raw = (method: string, payload: Record<string, unknown>) => Promise<any>
export type Run = {
  // The Bot API call, through grammY.
  raw: Raw
  // Where a case sends, and where it edits and deletes.
  sendTo: string | number
  editIn: string | number
  pace: number
  // Told each wait a 429 asks for.
  note?: (line: string) => void
  // Called once each case is read, before its messages are deleted.
  read?: (c: Case, seen: Seen) => void
}
export type Outcome = { cases: { name: string; seen: Seen }[]; stopped?: string; undeleted: number[] }

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Runs each case in turn, and deletes each message Telegram took once its
// case is read. A run that stops partway, on a call that failed to reach
// Telegram or a message an edit case could not send, deletes every message
// still undeleted before it returns. The outcome names each message it could
// not delete.
export async function runCases(run: Run): Promise<Outcome> {
  const ask = async (method: string, payload: Record<string, unknown>): Promise<{ ok: true; result: any } | { ok: false; description: string }> => {
    for (;;) {
      await pause(run.pace)
      try {
        return { ok: true, result: await run.raw(method, payload) }
      } catch (err) {
        const e = err as { error_code?: number; description?: string; parameters?: { retry_after?: number } }
        if (typeof e?.error_code !== 'number' || typeof e.description !== 'string') throw err
        const wait = e.parameters?.retry_after
        if (e.error_code === 429 && typeof wait === 'number') {
          run.note?.(`Telegram asks to wait ${wait} s before ${method}; waiting`)
          await pause(wait * 1000)
          continue
        }
        return { ok: false, description: e.description }
      }
    }
  }
  const taken = new Set<number>()
  const took = (result: any) => {
    for (const m of Array.isArray(result) ? result : [result]) if (typeof m?.message_id === 'number') taken.add(m.message_id)
  }
  const undeleted: number[] = []
  const remove = async () => {
    for (const id of [...taken]) {
      taken.delete(id)
      let gone = false
      try { gone = (await ask('deleteMessage', { chat_id: run.editIn, message_id: id })).ok } catch {}
      if (!gone) undeleted.push(id)
    }
  }
  const cases: Outcome['cases'] = []
  try {
    for (const c of CASES) {
      let target: number | undefined
      if (c.method === 'editMessageText' || c.method === 'editMessageCaption') {
        const ofText = c.method === 'editMessageText' ? c.on !== 'file' : c.on === 'text'
        const base = ofText
          ? await ask('sendMessage', { chat_id: run.sendTo, text: BASE, disable_notification: true })
          : await ask('sendDocument', { chat_id: run.sendTo, document: file(), caption: BASE, disable_notification: true })
        if (!base.ok) throw new Error(`the message ${c.name} edits was refused: ${base.description}`)
        took(base.result)
        target = (base.result as { message_id: number }).message_id
      }
      const a = c.method === 'sendMessage' ? await ask(c.method, { chat_id: run.sendTo, text: c.value, disable_notification: true })
        : c.method === 'sendDocument' ? await ask(c.method, { chat_id: run.sendTo, document: file(), caption: c.value, disable_notification: true })
        : c.method === 'sendMediaGroup' ? await ask(c.method, { chat_id: run.sendTo, disable_notification: true, media: [
            { type: 'document', media: file(), caption: c.value }, { type: 'document', media: file() }] })
        : c.method === 'editMessageText' ? await ask(c.method, { chat_id: run.editIn, message_id: target, text: c.value })
        : await ask(c.method, { chat_id: run.editIn, message_id: target, caption: c.value })
      let seen: Seen
      if (!a.ok) seen = { refused: a.description }
      else {
        if (c.method.startsWith('send')) took(a.result)
        const r = a.result
        seen = c.method === 'sendMessage' ? { text: r.text ?? null }
          : c.method === 'sendMediaGroup' ? { captions: (r as any[]).map(m => m.caption ?? null) }
          : c.method === 'editMessageText' || r === true ? { edited: true }
          : { caption: r.caption ?? null }
      }
      cases.push({ name: c.name, seen })
      run.read?.(c, seen)
      await remove()
    }
    return { cases, undeleted }
  } catch (err) {
    return { cases, stopped: err instanceof Error ? err.message : String(err), undeleted }
  } finally {
    await remove()
  }
}

// A text as a line can show it: quoted, each character outside printable
// ASCII escaped, and a run of more than eight of one character written once
// with its count.
export function quote(s: string): string {
  const one = (ch: string) => {
    if (ch === '"' || ch === '\\') return '\\' + ch
    if (ch === '\n') return '\\n'
    if (ch === '\t') return '\\t'
    if (ch === '\r') return '\\r'
    const cp = ch.codePointAt(0)!
    if (cp >= 0x20 && cp < 0x7f) return ch
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`
  }
  const chars = [...s]
  let out = ''
  for (let i = 0; i < chars.length;) {
    let j = i
    while (j < chars.length && chars[j] === chars[i]) j++
    out += j - i > 8 ? `{${one(chars[i]!)}\u00d7${j - i}}` : chars.slice(i, j).map(one).join('')
    i = j
  }
  return `"${out}"`
}
export function show(seen: Seen): string {
  if ('refused' in seen) return `refused: ${seen.refused}`
  if ('text' in seen) return seen.text === null ? 'no text' : `text ${quote(seen.text)}`
  if ('caption' in seen) return seen.caption === null ? 'no caption' : `caption ${quote(seen.caption)}`
  if ('captions' in seen) return `captions [${seen.captions.map(c => c === null ? 'none' : quote(c)).join(', ')}]`
  return 'edited'
}

// Every part of a token a line could hold: the whole, the bot's id before
// its colon and the secret after it.
function masker(token: string): (line: string) => string {
  const parts = [token, ...token.split(':')].filter(p => p.length >= 4).sort((a, b) => b.length - a.length)
  return line => parts.reduce((l, p) => l.split(p).join('<token>'), line)
}

const USAGE = 'usage: TELEGRAM_LIVE_CHECK_TOKEN=<bot token> bun live-check.ts --chat <chat id> [--pace <ms>]'

async function main(): Promise<number> {
  const token = process.env.TELEGRAM_LIVE_CHECK_TOKEN ?? ''
  const mask = masker(token)
  // Its own output, not the server's, so it writes to its own stdout and stderr.
  const say = (line: string) => { process.stdout.write(mask(line) + '\n') }
  const warn = (line: string) => { process.stderr.write(mask(line) + '\n') }
  const args = process.argv.slice(2)
  let chat: string | undefined
  let pace = 1000
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]]
    if (flag === '--chat' && value !== undefined && /^(-?\d+|@\w+)$/.test(value)) chat = value
    else if (flag === '--pace' && value !== undefined && /^\d+$/.test(value)) pace = Number(value)
    else { warn(`live-check: ${flag} ${value ?? ''} is not an option it takes; nothing was sent\n${USAGE}`); return 2 }
  }
  if (!token) { warn(`live-check: no token: set TELEGRAM_LIVE_CHECK_TOKEN to the bot's token; nothing was sent\n${USAGE}`); return 2 }
  if (!chat) { warn(`live-check: no chat: name it with --chat; nothing was sent\n${USAGE}`); return 2 }

  // The stand-in's run, in a process of its own whose environment holds
  // nothing of this one's but where programs and the temp folder are.
  const env: Record<string, string> = {}
  for (const name of ['PATH', 'HOME', 'TMPDIR']) if (process.env[name] !== undefined) env[name] = process.env[name]!
  const child = spawnSync(process.execPath, [join(import.meta.dir, 'fixtures', 'live-check-stand-in.ts')], { env, encoding: 'utf8', timeout: 120_000 })
  let stand: { cases: { name: string; seen: Seen; bridged?: Seen }[] }
  try {
    if (child.status !== 0) throw new Error(`it exited ${child.status ?? child.signal}`)
    stand = JSON.parse(child.stdout)
  } catch (err) {
    warn(`live-check: the stand-in's run failed (${err instanceof Error ? err.message : err}); nothing was sent\n${child.stderr ?? ''}`)
    return 2
  }

  const bot = new Bot(token)
  const target = /^-?\d+$/.test(chat) ? Number(chat) : chat
  const live = await runCases({ raw: (method, payload) => (bot.api.raw as any)[method](payload), sendTo: target, editIn: target, pace, note: say })
  const same = (a: Seen | undefined, b: Seen | undefined) => JSON.stringify(a) === JSON.stringify(b)
  const differ: string[] = []
  for (const { name, seen } of live.cases) {
    const s = stand.cases.find(c => c.name === name)
    const bridgedDiffers = s?.bridged !== undefined && !same(seen, s.bridged)
    if (s && same(seen, s.seen) && !bridgedDiffers) { say(`same     ${name}: ${show(seen)}`); continue }
    differ.push(name)
    say(`DIFFERS  ${name}: Telegram ${show(seen)}; the stand-in ${s ? show(s.seen) : 'ran no such case'}` +
      (bridgedDiffers ? `; the update it bridged ${show(s!.bridged!)}` : ''))
  }
  say(`${live.cases.length - differ.length} of ${CASES.length} cases agree` + (differ.length ? `; ${differ.length} differ: ${differ.join(', ')}` : ''))
  if (live.stopped !== undefined) warn(`live-check: the run stopped after ${live.cases.length} of ${CASES.length} cases: ${live.stopped}`)
  if (live.undeleted.length) warn(`live-check: ${live.undeleted.length} messages it sent could not be deleted: ${live.undeleted.join(', ')}`)
  if (live.stopped !== undefined || live.undeleted.length) return 2
  return differ.length ? 1 : 0
}

if (import.meta.main) process.exitCode = await main()
