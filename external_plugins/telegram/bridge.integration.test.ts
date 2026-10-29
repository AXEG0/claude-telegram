import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { cleanup, driveClock, start, state, until, wait } from './fixtures/harness.ts'
import fixture from './fixtures/channel-argv.json'
import { BOT_FILE_GAP_MS } from './batch.ts'

beforeEach(driveClock)
afterEach(cleanup)

// A reply with text and files from this plugin to another bot running it
// reaches the receiving Claude as one message, however long the upload takes.
// The sender's real reply tool sends through the fake Telegram, which hands
// each message to the receiver's real server as Telegram would (see
// TELEGRAM_TEST_BRIDGE in fixtures/telegram-preload.ts), both on one clock.

// The receiving bot as the sender knows it. The sender is the fake's own bot,
// test_bot, id 123, which the receiver allowlists.
const RECEIVER = { id: 7090, is_bot: true, first_name: 'Receiver', username: 'receiving_bot' }
// Each file and album upload takes 9 s, longer than any wait of the
// receiver's, and each text send 700 ms.
const SLOW = [
  { method: ['sendDocument', 'sendPhoto', 'sendMediaGroup'], preMs: 9000 },
  { method: 'sendMessage', preMs: 700 },
]
// A batch goes out at most a gap after its last message, the longest gap a
// bot's file's, and a message reaches the receiver at most a move of the
// clock and a poll after the sender's Telegram took it. So once the reply has
// returned, every message it sent reaches Claude within this.
const SETTLE_MS = BOT_FILE_GAP_MS + 1000

async function bridged(access: object = {}) {
  const receiverDir = state({ dmPolicy: 'allowlist', allowFrom: ['1', '123'] })
  const bridge = join(receiverDir, 'bridge')
  const receiver = start(receiverDir, fixture.argv, { TELEGRAM_TEST_BRIDGE: JSON.stringify({ dir: bridge }) })
  await receiver.ready()
  await until(() => receiver.stderr().includes('polling as '), 6000)
  const senderDir = state({ dmPolicy: 'allowlist', allowFrom: ['1', String(RECEIVER.id)], ...access })
  mkdirSync(join(senderDir, 'inbox'))
  const sender = start(senderDir, ['claude', '-p', 'hello'], {
    TELEGRAM_TEST_USERS: JSON.stringify({ [RECEIVER.id]: RECEIVER }),
    TELEGRAM_TEST_BRIDGE: JSON.stringify({ dir: bridge, username: RECEIVER.username }),
    TELEGRAM_TEST_RULES: JSON.stringify(SLOW),
  })
  await sender.ready()
  const file = (name: string) => { const path = join(senderDir, 'inbox', name); writeFileSync(path, name); return path }
  // Sends the reply, then waits until whatever it sent has reached Claude.
  async function reply(text: string, names: string[]) {
    const result = (await sender.request('tools/call', { name: 'reply', arguments: { chat_id: String(RECEIVER.id), text, files: names.map(file) } }, 20000)).result
    expect(result.isError).not.toBe(true)
    await wait(SETTLE_MS)
    return receiver.inbound()
  }
  return { reply }
}

// The one message Claude gets: the text whole, every file and every id.
function expectOne(inbound: { content: string; meta: Record<string, string> }[], content: string, names: string[], messages: number) {
  expect(inbound.map(n => n.content)).toEqual([content])
  const { meta } = inbound[0]!
  expect([meta.user, meta.chat_id]).toEqual(['test_bot', '123'])
  expect(meta.message_ids ?? meta.message_id).toBe(Array.from({ length: messages }, (_, i) => i + 1).join(','))
  expect(meta.attachment_file_id).toBe(`file-of-${names[0]}`)
  expect(meta.attachment_file_ids).toBe(names.length > 1 ? names.map(n => `file-of-${n}`).join(',') : undefined)
  expect(meta.attachment_names).toBe(names.length > 1 ? names.join(',') : undefined)
}

describe.skipIf(process.platform !== 'linux')('a reply from this plugin to another bot running it', () => {
  test('one file with a short text arrives as one message', async () => {
    const b = await bridged()
    expectOne(await b.reply('the report is attached', ['report.pdf']), 'the report is attached', ['report.pdf'], 1)
  }, 60000)

  test('one file with a text over 1024 characters arrives as one message', async () => {
    const b = await bridged()
    const text = 'the long description. '.repeat(70).trim()
    expectOne(await b.reply(text, ['report.pdf']), `(document: report.pdf)\n${text}`, ['report.pdf'], 2)
  }, 60000)

  test('three files with a short text arrive as one message', async () => {
    const b = await bridged()
    const names = ['a.txt', 'b.json', 'c.csv']
    expectOne(await b.reply('three files', names), 'three files\n(document: b.json)\n(document: c.csv)', names, 3)
  }, 60000)

  test('two files with a 5000-character text, a line break and a space where a 4096 cut would fall, arrive as one message, chunkMode and textChunkLimit aside', async () => {
    const b = await bridged({ chunkMode: 'newline', textChunkLimit: 1000 })
    const text = 'word '.repeat(818) + 'wordy' + '\n' + ' ' + 'tail '.repeat(180) + 'end'
    expect([text.length, text[4095], text[4096]]).toEqual([5000, '\n', ' '])
    const names = ['a.txt', 'b.txt']
    expectOne(await b.reply(text, names), `(document: a.txt)\n(document: b.txt)\n${text}`, names, 4)
  }, 60000)

  test('a photo and a document with a text arrive as one message', async () => {
    const b = await bridged()
    const names = ['chart.png', 'notes.txt']
    expectOne(await b.reply('the chart and its notes', names), 'the chart and its notes\n(document: notes.txt)', names, 2)
  }, 60000)

  test('two files with no text arrive as one message', async () => {
    const b = await bridged()
    const names = ['a.txt', 'b.txt']
    expectOne(await b.reply('', names), '(document: a.txt)\n(document: b.txt)', names, 2)
  }, 60000)
})
