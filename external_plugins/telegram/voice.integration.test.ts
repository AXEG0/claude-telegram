// A message's file work beside the update loop, the per-sender lane, the
// limit and its reason, and the record of arrivals with its replay at start,
// in the running server. Only Telegram's HTTP, its file host and the
// transcription endpoint are fake (fixtures/telegram-preload.ts).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import fixture from './fixtures/channel-argv.json'
import { calls, cleanup, CONFLICT, deliver, driveClock, EXIT_MS, start, state, STEP_MS, until, wait, type Server } from './fixtures/harness.ts'
import { TEXT_GAP_MS } from './batch.ts'
import { row, session } from './fixtures/session.ts'
import { metaText } from './reply.ts'

beforeEach(driveClock)
afterEach(cleanup)

const OWNER = { id: 1, is_bot: false, first_name: 'Owner', username: 'owner' }
const OTHER = { id: 2, is_bot: false, first_name: 'Other', username: 'other' }
const STRANGER = { id: 3, is_bot: false, first_name: 'Stranger' }
// The username getMe gives in the test fixture.
const BOT = 'test_bot'
const dmOf = (u: { id: number }) => ({ id: u.id, type: 'private' })
const seconds = () => Math.floor(Date.now() / 1000)
const HOUR = 60 * 60 * 1000

// The files Telegram holds, by file id: the transcription answers
// "heard: " and the file's text.
const FILES: Record<string, { path: string; text: string }> = {
  v1: { path: 'voice/file_1.oga', text: 'the first note' },
  v2: { path: 'voice/file_2.oga', text: 'the second note' },
  v3: { path: 'voice/file_3.oga', text: 'the third note' },
  p1: { path: 'photos/file_4.jpg', text: 'jpeg bytes' },
}
const heard = (fileId: string) => `[transcript] heard: ${FILES[fileId]!.text}`

type Update = { update_id: number } & Record<string, unknown>
const message = (update_id: number, from: { id: number }, extra: object, chat: object = dmOf(from), date = seconds()): Update =>
  ({ update_id, message: { message_id: 100 + update_id, date, from, chat, ...extra } })
const text = (id: number, from: { id: number }, t: string, chat?: object) => message(id, from, { text: t }, chat)
const voice = (id: number, from: { id: number }, fileId: string, date?: number) =>
  message(id, from, { voice: { file_id: fileId, file_unique_id: `u-${fileId}`, duration: 3, mime_type: 'audio/ogg', file_size: FILES[fileId]!.text.length } }, undefined, date)
const photo = (id: number, from: { id: number }, fileId: string) =>
  message(id, from, { photo: [{ file_id: fileId, file_unique_id: `u-${fileId}`, width: 1, height: 1, file_size: 10 }] })
const reaction = (id: number, from: { id: number }, message_id: number, emoji: string): Update =>
  ({ update_id: id, message_reaction: { chat: dmOf(from), message_id, user: from, date: seconds(), old_reaction: [], new_reaction: [{ type: 'emoji', emoji }] } })

const PEOPLE = { dmPolicy: 'allowlist', allowFrom: ['1', '2'] }
// Pairing mode, read live: a stranger's message gets a pairing reply, which a
// rule holds, and the loop with it.
const PAIRING_ACCESS = { dmPolicy: 'pairing', allowFrom: ['1'], groups: {}, pending: {} }
const PAIRING = { TELEGRAM_ACCESS_MODE: '' }
const holdPairing = (ms: number) => ({ method: 'sendMessage', has: 'Pairing required', holdMs: ms })
const pairingHeld = (dir: string) => calls(dir).some(c => c.method === 'sendMessage' && String(c.payload.text).startsWith('Pairing required'))

function server(dir: string, rules: object[] = [], env: Record<string, string> = {}): Server {
  return start(dir, fixture.argv, {
    TELEGRAM_STT_OPENAI_KEY: 'test-key',
    TELEGRAM_TEST_FILES: JSON.stringify(FILES),
    TELEGRAM_TEST_RULES: JSON.stringify(rules),
    ...env,
  })
}
const contents = (s: Server) => s.inbound().map(n => n.content)
const called = (dir: string, method: string) => calls(dir).some(c => c.method === method)
const record = (dir: string): any[] => {
  try {
    return readFileSync(join(dir, 'arrivals.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  } catch {
    return []
  }
}
const doneLine = (dir: string, id: number) => record(dir).find(l => l.line === 'done' && l.update_id === id)
const writeRecord = (dir: string, lines: object[]) =>
  writeFileSync(join(dir, 'arrivals.jsonl'), lines.map(l => `${JSON.stringify(l)}\n`).join(''))
const startLine = (update: Update, sent = Date.now(), arrived = Date.now(), at = arrived) =>
  ({ line: 'start', update_id: update.update_id, sent, arrived, at, update })
// Kills the production server at once, as a crash would.
async function kill(s: Server): Promise<void> {
  process.kill(s.serverPid(), 'SIGKILL')
  await until(() => s.exited(), 4000)
}
const polledBy = (dir: string, s: Server) => calls(dir).some(c => c.method === 'getUpdates' && c.pid === s.serverPid())
// The updates whose newest line in the record is a start line.
const unfinished = (dir: string) => {
  const newest = new Map<number, string>()
  for (const l of record(dir)) newest.set(l.update_id, l.line)
  return [...newest].filter(([, line]) => line === 'start').map(([id]) => id)
}
// The reaction from the sender of a held note, and the text from another chat,
// sent in one round at `from`: the reaction goes at once, within the clock's
// step, and the text after its batch gap.
async function passedAtOnce(channel: Server, from: number): Promise<void> {
  await until(() => channel.inbound().some(n => n.meta.reaction === '👍'), 2000)
  expect(Date.now() - from).toBeLessThan(2 * STEP_MS)
  await until(() => contents(channel).includes('from another chat'), 2000)
  expect(Date.now() - from).toBeLessThan(TEXT_GAP_MS + 2 * STEP_MS)
}

describe.skipIf(process.platform !== 'linux')('a message\'s file work beside the update loop', () => {
  test('I1 a voice note whose download takes 45 s holds no other chat and no reaction, and its sender\'s text comes after it', async () => {
    const dir = state(PEOPLE)
    const channel = server(dir, [{ method: 'download', holdMs: 45_000 }])
    await channel.ready()
    deliver(dir, [voice(1, OWNER, 'v1')])
    await until(() => called(dir, 'download'), 4000)
    const t0 = Date.now()
    await wait(5000)
    deliver(dir, [text(2, OTHER, 'from another chat'), reaction(3, OWNER, 500, '👍'), text(4, OWNER, 'after my note')])
    const t5 = Date.now()
    await passedAtOnce(channel, t5)
    await until(() => contents(channel).includes(heard('v1')), 50_000)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(44_000)
    expect(Date.now() - t0).toBeLessThan(46_000)
    await until(() => contents(channel).includes('after my note'), 4000)
    const order = contents(channel)
    expect(order.indexOf(heard('v1'))).toBeLessThan(order.indexOf('after my note'))
    expect(order.filter(c => c === 'after my note')).toHaveLength(1)
    // The record times each step: the download held 45 s.
    await until(() => doneLine(dir, 1) !== undefined, 4000)
    expect(doneLine(dir, 1).ms.download).toBeGreaterThanOrEqual(45_000)
    expect(doneLine(dir, 1).ms.download).toBeLessThan(45_000 + 2 * STEP_MS)
    expect(doneLine(dir, 1).outcome).toBe('transcribed')
    await channel.close()
  }, 60000)

  test('I1b a voice note whose getFile takes 45 s holds no other chat and no reaction, and its sender\'s text comes after it', async () => {
    const dir = state(PEOPLE)
    const channel = server(dir, [{ method: 'getFile', holdMs: 45_000 }])
    await channel.ready()
    deliver(dir, [voice(1, OWNER, 'v1')])
    await until(() => called(dir, 'getFile'), 4000)
    const t0 = Date.now()
    await wait(5000)
    deliver(dir, [text(2, OTHER, 'from another chat'), reaction(3, OWNER, 500, '👍'), text(4, OWNER, 'after my note')])
    const t5 = Date.now()
    await passedAtOnce(channel, t5)
    await until(() => channel.inbound().some(n => n.meta.message_id === '101'), 50_000)
    expect(contents(channel)).toContain(heard('v1'))
    expect(Date.now() - t0).toBeGreaterThanOrEqual(44_000)
    expect(Date.now() - t0).toBeLessThan(46_000)
    await until(() => contents(channel).includes('after my note'), 4000)
    const order = contents(channel)
    expect(order.indexOf(heard('v1'))).toBeLessThan(order.indexOf('after my note'))
    await channel.close()
  }, 60000)

  test('I2 a note the transcription refuses reaches Claude with the reason, which the record keeps whole across a restart', async () => {
    const dir = state()
    const body = '<html>\n<body class="error">Bad gateway; try again</body>\n</html>'
    const channel = server(dir, [{ method: 'transcribe', error: { error_code: 502, description: 'Bad Gateway' }, body }])
    await channel.ready()
    deliver(dir, [voice(1, OWNER, 'v1')])
    await until(() => doneLine(dir, 1) !== undefined, 6000)
    const [note] = channel.inbound()
    expect(note.content).toBe('(voice message)')
    expect(note.meta.transcript_error).toBe(metaText(`transcription HTTP 502: ${body}`, 300))
    expect(note.meta.transcript_error).toContain('HTTP 502')
    expect(note.meta.transcript_error).not.toMatch(/[<>"\n]/)
    expect(note.meta.audio_path).toBeDefined()
    expect(note.meta.attachment_file_id).toBe('v1')
    const reason = `transcription HTTP 502: ${body}`
    expect(doneLine(dir, 1)).toMatchObject({ outcome: 'untranscribed', reason })
    await channel.close()
    const next = server(dir)
    await next.ready()
    await until(() => polledBy(dir, next), 4000)
    await wait(1000)
    expect(doneLine(dir, 1)?.reason).toBe(reason)
    expect(next.inbound()).toEqual([])
    await next.close()
  }, 30000)

  test('I3 a note in its download when the server is killed reaches the next session transcribed', async () => {
    const dir = state()
    const channel = server(dir, [{ method: 'download', holdMs: 15_000 }])
    await channel.ready()
    deliver(dir, [voice(1, OWNER, 'v1')])
    await until(() => called(dir, 'download'), 4000)
    await wait(10_000)
    const first = channel.serverPid()
    await kill(channel)
    const confirming = calls(dir).find(c => c.method === 'getUpdates' && c.pid === first && c.payload.offset === 2)
    expect(confirming?.started).toContain(1)
    const next = server(dir)
    await next.ready()
    await until(() => next.inbound().length > 0, 6000)
    expect(contents(next)).toEqual([heard('v1')])
    await next.close()
  }, 30000)

  test('I4 a note whose download finishes while the server shuts down goes to the next session, not the stopping one', async () => {
    const dir = state()
    const env = {
      TELEGRAM_STT_OPENAI_KEY: 'test-key',
      TELEGRAM_TEST_FILES: JSON.stringify(FILES),
      TELEGRAM_TEST_RULES: JSON.stringify([{ method: 'download', holdMs: 15_000 }, { method: 'editMessageText', has: 'No longer followed', holdMs: 6000 }]),
    }
    const s = await session(env, dir)
    s.begin('a1', 'Long job')
    await s.next(t => row(t, 1).startsWith('1. ⏳'))
    deliver(dir, [voice(2, OWNER, 'v1')])
    await until(() => called(dir, 'download'), 4000)
    const t0 = Date.now()
    await wait(14_000)
    s.channel.child.stdin.end()
    await until(() => s.channel.exited(), EXIT_MS)
    expect(Date.now() - t0).toBeGreaterThan(15_000)
    expect(contents(s.channel)).toEqual(['subagents test'])
    expect(doneLine(dir, 2)).toBeUndefined()
    const next = server(dir)
    await next.ready()
    await until(() => next.inbound().length > 0, 6000)
    expect(contents(next)).toEqual([heard('v1')])
    await next.close()
  }, 40000)

  test('I5 a note the record holds unfinished, which the first poll brings again, reaches Claude once', async () => {
    const dir = state()
    const note = voice(7, OWNER, 'v1')
    writeRecord(dir, [startLine(note)])
    deliver(dir, [note])
    const channel = server(dir)
    await channel.ready()
    await until(() => channel.inbound().length > 0, 6000)
    await until(() => !existsSync(join(dir, 'inbound.json')), 4000)
    await wait(1000)
    expect(contents(channel)).toEqual([heard('v1')])
    await channel.close()
  }, 20000)

  test('I6 two voice notes from one sender download side by side and arrive in order', async () => {
    const dir = state()
    const channel = server(dir, [{ method: 'download', holdMs: 5000 }])
    await channel.ready()
    deliver(dir, [voice(1, OWNER, 'v1'), voice(2, OWNER, 'v2')])
    await until(() => called(dir, 'download'), 4000)
    const t0 = Date.now()
    await until(() => channel.inbound().length === 2, 12_000)
    expect(Date.now() - t0).toBeLessThan(6000)
    expect(contents(channel)).toEqual([heard('v1'), heard('v2')])
    await channel.close()
  }, 30000)

  test('I7 a photo whose download is held lets another chat\'s text through at once', async () => {
    const dir = state(PEOPLE)
    const channel = server(dir, [{ method: 'download', holdMs: 5000 }])
    await channel.ready()
    deliver(dir, [photo(1, OWNER, 'p1')])
    await until(() => called(dir, 'download'), 4000)
    await wait(1000)
    deliver(dir, [text(2, OTHER, 'meanwhile')])
    const t1 = Date.now()
    await until(() => contents(channel).includes('meanwhile'), 2000)
    expect(Date.now() - t1).toBeLessThan(1000)
    await until(() => channel.inbound().some(n => n.meta.image_path), 8000)
    expect(doneLine(dir, 1)).toMatchObject({ outcome: 'photo saved' })
    await channel.close()
  }, 30000)

  test('I8 an edit of a text sent behind a held note comes after the note and the text', async () => {
    const dir = state()
    const channel = server(dir, [{ method: 'download', holdMs: 3000 }])
    await channel.ready()
    deliver(dir, [
      voice(1, OWNER, 'v1'),
      text(2, OWNER, 'deploy to staging'),
      { update_id: 3, edited_message: { message_id: 102, date: seconds(), edit_date: seconds() + 1, from: OWNER, chat: dmOf(OWNER), text: 'deploy to prod' } },
    ])
    await until(() => channel.inbound().length === 3, 10_000)
    expect(contents(channel)).toEqual([heard('v1'), 'deploy to staging', 'deploy to prod'])
    expect(channel.inbound()[2]!.meta.edited).toBe('true')
    await channel.close()
  }, 30000)

  test('I10 the poll heartbeat advances while a download is held', async () => {
    const dir = state()
    const channel = server(dir, [{ method: 'download', holdMs: 5000 }])
    await channel.ready()
    deliver(dir, [voice(1, OWNER, 'v1')])
    await until(() => called(dir, 'download'), 4000)
    const beat = () => JSON.parse(readFileSync(join(dir, 'poll-heartbeat.json'), 'utf8')).at as number
    const first = beat()
    await wait(3000)
    expect(beat()).toBeGreaterThan(first + 2000)
    await channel.close()
  }, 20000)

  test('I11 a press and a typed permission answer from the sender of a held note reach Claude before the note', async () => {
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1'] })
    const channel = server(dir, [{ method: 'download', holdMs: 5000 }], {
      TELEGRAM_ALERT_CHAT: '1',
      TELEGRAM_TEST_CHATS: JSON.stringify({ ids: 100 }),
    })
    await channel.ready()
    await until(() => channel.stderr().includes('polling as '), 6000)
    const sent = (await channel.request('tools/call', { name: 'reply', arguments: { chat_id: '1', text: 'Merge now?', buttons: [['Yes', 'No']] } })).result
    const asked = Number(/; buttons on message (\d+)$/.exec(sent.content[0].text)![1])
    const send = calls(dir).find(c => c.method === 'sendMessage' && c.message_id === asked)!
    const markup = typeof send.payload.reply_markup === 'string' ? JSON.parse(send.payload.reply_markup) : send.payload.reply_markup
    const data = markup.inline_keyboard.flat().find((b: { text: string }) => b.text === 'Yes').callback_data
    deliver(dir, [voice(1, OWNER, 'v1')])
    await until(() => called(dir, 'download'), 4000)
    deliver(dir, [
      { update_id: 2, callback_query: { id: 'cb1', chat_instance: 'c', data, from: OWNER, message: { message_id: asked, date: seconds(), chat: dmOf(OWNER), text: 'Merge now?', reply_markup: markup } } },
      text(3, OWNER, 'yes abcde'),
    ])
    const answered = () => channel.notifications.some(n => n.method === 'notifications/claude/channel/permission')
    await until(() => answered() && channel.inbound().some(n => n.meta.button === 'Yes'), 2000)
    expect(contents(channel)).not.toContain(heard('v1'))
    await until(() => contents(channel).includes(heard('v1')), 8000)
    await channel.close()
  }, 30000)

  test('I16 with the record unwritable, a held note still arrives transcribed and another chat passes at once', async () => {
    const dir = state(PEOPLE)
    mkdirSync(join(dir, 'arrivals.jsonl'))
    const channel = server(dir, [{ method: 'download', holdMs: 5000 }])
    await channel.ready()
    deliver(dir, [voice(1, OWNER, 'v1')])
    await until(() => called(dir, 'download'), 4000)
    deliver(dir, [text(2, OTHER, 'meanwhile')])
    const t1 = Date.now()
    await until(() => contents(channel).includes('meanwhile'), 2000)
    expect(Date.now() - t1).toBeLessThan(1000)
    await until(() => contents(channel).includes(heard('v1')), 8000)
    expect(channel.stderr()).toContain('arrivals.jsonl not written')
    expect(channel.stderr()).toContain('arrivals.jsonl not read')
    await channel.close()
  }, 30000)
})

describe.skipIf(process.platform !== 'linux')('the replay of the record at start', () => {
  test('I21 a delivered burst of two texts and a delivered edit are not delivered again by the next server', async () => {
    const dir = state()
    const channel = server(dir)
    await channel.ready()
    deliver(dir, [text(1, OWNER, 'first half'), text(2, OWNER, 'second half')])
    await until(() => channel.inbound().length === 1, 4000)
    expect(contents(channel)).toEqual(['first half\nsecond half'])
    deliver(dir, [{ update_id: 3, edited_message: { message_id: 102, date: seconds(), edit_date: seconds() + 1, from: OWNER, chat: dmOf(OWNER), text: 'second half, edited' } }])
    await until(() => channel.inbound().length === 2, 4000)
    expect(contents(channel)[1]).toBe('second half, edited')
    await wait(500)
    await channel.close()
    const next = server(dir)
    await next.ready()
    await until(() => polledBy(dir, next), 4000)
    await wait(1500)
    expect(next.inbound()).toEqual([])
    await next.close()
  }, 20000)

  test('I22 an edit that leaves its text as Claude last got it writes no start line', async () => {
    const dir = state()
    const channel = server(dir)
    await channel.ready()
    deliver(dir, [
      text(1, OWNER, 'as it was'),
      { update_id: 2, edited_message: { message_id: 101, date: seconds(), edit_date: seconds() + 1, from: OWNER, chat: dmOf(OWNER), text: 'as it was', entities: [{ type: 'italic', offset: 0, length: 2 }] } },
    ])
    await until(() => channel.inbound().length === 1, 4000)
    await wait(1000)
    expect(contents(channel)).toEqual(['as it was'])
    expect(record(dir).filter(l => l.update_id === 2)).toEqual([])
    expect(unfinished(dir)).toEqual([])
    await channel.close()
  }, 20000)

  test('I12 a replay goes on past an entry whose handling throws, and a poll retry replays nothing again', async () => {
    const dir = state()
    const note = voice(3, OWNER, 'v1')
    writeRecord(dir, [
      startLine(text(1, OWNER, 'from the record')),
      { line: 'start', update_id: 2, sent: Date.now(), arrived: Date.now(), at: Date.now(), update: null },
      startLine(note),
    ])
    const channel = server(dir, [{ method: 'getUpdates', times: 1, error: CONFLICT }, { method: 'download', holdMs: 5000 }])
    await channel.ready()
    await until(() => channel.stderr().includes('409 Conflict'), 4000)
    await until(() => calls(dir).some(c => c.method === 'getUpdates' && !c.refused), 4000)
    deliver(dir, [text(4, OWNER, 'a new text')])
    await until(() => contents(channel).includes('a new text'), 10_000)
    await wait(1000)
    expect(contents(channel)).toEqual(['from the record', heard('v1'), 'a new text'])
    expect(doneLine(dir, 2)?.reason).toContain('replay failed')
    expect(record(dir).filter(l => l.line === 'replayed' && l.update_id === 3)).toEqual([])
    await channel.close()
  }, 30000)

  test('I13 a recorded group message that mentions the bot is delivered on replay', async () => {
    const dir = state({ dmPolicy: 'allowlist', allowFrom: ['1'], groups: { '-100': { requireMention: true, allowFrom: [] } } })
    const group = { id: -100, type: 'supergroup', title: 'g' }
    const mention = `@${BOT} check this`
    writeRecord(dir, [startLine(message(1, OTHER, { text: mention, entities: [{ type: 'mention', offset: 0, length: BOT.length + 1 }] }, group))])
    const channel = server(dir)
    await channel.ready()
    await until(() => channel.inbound().length > 0, 6000)
    expect(contents(channel)).toEqual([mention])
    await channel.close()
  }, 20000)

  test('I14 entries over 24 h old are closed, not replayed, while a younger one is, and an old finished id never drops a new update', async () => {
    const dir = state()
    const now = Date.now()
    const at = (ms: number) => Math.floor((now - ms) / 1000)
    const old = voice(1, OWNER, 'v1', at(25 * HOUR))
    const young = voice(2, OWNER, 'v2', at(23 * HOUR))
    const again = voice(3, OWNER, 'v3', at(25 * HOUR))
    const week = text(4, OWNER, 'eight days ago')
    writeRecord(dir, [
      startLine(week, now - 8 * 24 * HOUR),
      { line: 'done', update_id: 4, at: now - 8 * 24 * HOUR, outcome: 'delivered' },
      startLine(old, now - 25 * HOUR, now - 25 * HOUR),
      startLine(young, now - 23 * HOUR, now - 23 * HOUR),
      startLine(again, now - 25 * HOUR, now - 1 * HOUR),
    ])
    deliver(dir, [text(4, OWNER, 'a new update with an old id')])
    const channel = server(dir)
    await channel.ready()
    await until(() => contents(channel).includes('a new update with an old id'), 6000)
    await wait(1000)
    expect(contents(channel)).toEqual([heard('v2'), 'a new update with an old id'])
    expect(doneLine(dir, 1)).toMatchObject({ outcome: 'not replayed', reason: 'older than 24 h, the time Telegram keeps an update' })
    expect(doneLine(dir, 3)).toMatchObject({ outcome: 'not replayed' })
    await channel.close()
  }, 20000)

  test('I15 a replayed note counts its limit from the replay, not from its first arrival', async () => {
    const dir = state()
    const tenMinutes = 10 * 60 * 1000
    const note = voice(1, OWNER, 'v1', Math.floor((Date.now() - tenMinutes) / 1000))
    writeRecord(dir, [startLine(note, Date.now() - tenMinutes, Date.now() - tenMinutes)])
    const channel = server(dir, [{ method: 'download', holdMs: 5000 }])
    await channel.ready()
    await until(() => channel.inbound().length > 0, 10_000)
    expect(contents(channel)).toEqual([heard('v1')])
    await channel.close()
  }, 20000)
})

describe.skipIf(process.platform !== 'linux')('delivery and order across a crash or a shutdown', () => {
  test('I17 a photo in its batch gap at a crash, with the round unconfirmed, arrives once in the next session', async () => {
    const dir = state(PAIRING_ACCESS)
    const channel = server(dir, [holdPairing(2000)], PAIRING)
    await channel.ready()
    const round = [photo(1, OWNER, 'p1'), text(2, STRANGER, 'let me in')]
    deliver(dir, round)
    const inbox = join(dir, 'inbox')
    await until(() => existsSync(inbox) && readdirSync(inbox).some(f => f.endsWith('.jpg')), 4000)
    await wait(1)
    expect(pairingHeld(dir)).toBe(true)
    await kill(channel)
    expect(channel.inbound()).toEqual([])
    deliver(dir, round)
    const next = server(dir, [], PAIRING)
    await next.ready()
    await until(() => next.inbound().length > 0, 6000)
    await until(() => !existsSync(join(dir, 'inbound.json')), 4000)
    await wait(1500)
    expect(next.inbound().map(n => n.meta.message_id)).toEqual(['101'])
    expect(next.inbound()[0]!.meta.image_path).toBeDefined()
    await next.close()
  }, 30000)

  test('I17b a text in its batch gap behind a delivered note at a crash arrives once in the next session, after the note', async () => {
    const dir = state(PAIRING_ACCESS)
    const channel = server(dir, [{ method: 'download', holdMs: 1000 }, holdPairing(3000)], PAIRING)
    await channel.ready()
    const round = [voice(1, OWNER, 'v1'), text(2, OWNER, 'right after'), text(3, STRANGER, 'let me in')]
    deliver(dir, round)
    await until(() => contents(channel).includes(heard('v1')), 4000)
    expect(pairingHeld(dir)).toBe(true)
    await kill(channel)
    expect(contents(channel)).toEqual([heard('v1')])
    deliver(dir, round)
    const next = server(dir, [], PAIRING)
    await next.ready()
    await until(() => next.inbound().length > 0, 6000)
    await until(() => !existsSync(join(dir, 'inbound.json')), 4000)
    await wait(1500)
    expect(contents(next)).toEqual(['right after'])
    await next.close()
  }, 30000)

  test('I18 a text and a note from one sender, cut by a crash before the confirming poll, arrive in order, each once', async () => {
    const dir = state(PAIRING_ACCESS)
    const channel = server(dir, [{ method: 'download', holdMs: 5000 }, holdPairing(3000)], PAIRING)
    await channel.ready()
    const round = [text(1, OWNER, 'listen to this'), voice(2, OWNER, 'v1'), text(3, STRANGER, 'let me in')]
    deliver(dir, round)
    await until(() => pairingHeld(dir), 4000)
    await wait(1000)
    await kill(channel)
    expect(channel.inbound()).toEqual([])
    deliver(dir, round)
    const next = server(dir, [], PAIRING)
    await next.ready()
    await until(() => next.inbound().length >= 2, 10_000)
    await until(() => !existsSync(join(dir, 'inbound.json')), 4000)
    await wait(1500)
    expect(contents(next)).toEqual(['listen to this', heard('v1')])
    await next.close()
  }, 30000)

  test('I18b a text and a note handled after a clean close began arrive in the next session in order, each once', async () => {
    const dir = state(PAIRING_ACCESS)
    const channel = server(dir, [{ method: 'download', holdMs: 5000 }, holdPairing(3000)], PAIRING)
    await channel.ready()
    const first = channel.serverPid()
    const round = [text(1, STRANGER, 'let me in'), text(2, OWNER, 'listen to this'), voice(3, OWNER, 'v1')]
    deliver(dir, round)
    await until(() => pairingHeld(dir), 4000)
    await wait(1000)
    channel.child.stdin.end()
    await until(() => channel.exited(), EXIT_MS)
    expect(channel.inbound()).toEqual([])
    // Telegram still holds every update at or above the stopping server's
    // last polled offset.
    const offset = Math.max(...calls(dir).filter(c => c.method === 'getUpdates' && c.pid === first).map(c => c.payload.offset ?? 0))
    expect(offset).toBe(2)
    deliver(dir, round.filter(u => u.update_id >= offset))
    const next = server(dir, [], PAIRING)
    await next.ready()
    await until(() => next.inbound().length >= 2, 10_000)
    await until(() => !existsSync(join(dir, 'inbound.json')), 4000)
    await wait(1500)
    expect(contents(next)).toEqual(['listen to this', heard('v1')])
    await next.close()
  }, 30000)

  test('I19 a lone text in its batch gap at a crash after the confirming poll arrives in the next session', async () => {
    const dir = state()
    const channel = server(dir)
    await channel.ready()
    deliver(dir, [text(1, OWNER, 'only this')])
    const pid = channel.serverPid()
    await until(() => calls(dir).some(c => c.method === 'getUpdates' && c.pid === pid && c.payload.offset === 2), 4000)
    await kill(channel)
    expect(channel.inbound()).toEqual([])
    const next = server(dir)
    await next.ready()
    await until(() => next.inbound().length > 0, 6000)
    await wait(1000)
    expect(contents(next)).toEqual(['only this'])
    await next.close()
  }, 20000)

  test('I20 a lone text in its batch gap when Claude Code has gone arrives once in the next session', async () => {
    const dir = state()
    const channel = server(dir)
    await channel.ready()
    deliver(dir, [text(1, OWNER, 'only this')])
    const pid = channel.serverPid()
    await until(() => calls(dir).some(c => c.method === 'getUpdates' && c.pid === pid && c.payload.offset === 2), 4000)
    channel.child.stdout.destroy()
    channel.child.stderr.destroy()
    channel.child.stdin.end()
    await until(() => channel.exited(), EXIT_MS)
    const next = server(dir)
    await next.ready()
    await until(() => next.inbound().length > 0, 6000)
    await wait(1000)
    expect(contents(next)).toEqual(['only this'])
    await next.close()
  }, 20000)
})
