import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import fixture from './fixtures/channel-argv.json'
import { calls, cleanup, driveClock, start, state, until, type Call, type Server } from './fixtures/harness.ts'
import { COPIES_MAX } from './log.ts'
import { TEXT_FILES_MAX } from './textfiles.ts'

// Folders of text files outside any state folder, removed after each test.
const folders: string[] = []
afterEach(async () => {
  try {
    await cleanup()
  } finally {
    for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true })
  }
})
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tg-text-files-'))
  folders.push(dir)
  return dir
}
function write(dir: string, name: string, content: string | Buffer): string {
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

// The owner and another bot on the allowlist.
const BOT = { id: 9000001, is_bot: true, first_name: 'Peer', username: 'peer_bot' }
const ACCESS = { dmPolicy: 'allowlist', allowFrom: ['1', String(BOT.id)] }
type Setup = { rich?: boolean; access?: object; rules?: object[]; chats?: object }
const envOf = (o: Setup) => ({
  TELEGRAM_RICH_MESSAGES: String(o.rich ?? false),
  TELEGRAM_TEST_USERS: JSON.stringify({ [BOT.id]: BOT }),
  TELEGRAM_TEST_CHATS: JSON.stringify(o.chats ?? { ids: 100 }),
  TELEGRAM_TEST_RULES: JSON.stringify(o.rules ?? []),
})
// A session's server that does not poll: it calls Telegram only for what a
// tool asks, so two of them on fresh stand-ins number their messages alike.
async function sender(o: Setup = {}): Promise<{ dir: string; srv: Server }> {
  const dir = state({ ...ACCESS, ...o.access })
  const srv = start(dir, ['claude', '-p', 'hello'], envOf(o))
  await srv.ready()
  return { dir, srv }
}
// The server that polls the bot, as buttons need.
async function channel(o: Setup = {}): Promise<{ dir: string; srv: Server }> {
  const dir = state({ ...ACCESS, ...o.access })
  const srv = start(dir, fixture.argv, envOf(o))
  await srv.ready()
  await until(() => srv.stderr().includes('polling as '), 6000)
  return { dir, srv }
}
const tool = async (srv: Server, name: string, args: object) =>
  (await srv.request('tools/call', { name, arguments: args })).result

// Telegram's calls as the stand-in logged them, without the process and the
// time, which differ between two servers.
const made = (dir: string) => calls(dir).map(({ pid: _, at: __, ...c }) => c)

// The answer of a call through text_files: the answer typed text gets, and the
// saved copy it names.
const SAVED = /; the words sent are saved in (\/\S+\.jsonl)$/
function split(text: string): { answer: string; copy: string } {
  const m = SAVED.exec(text)
  if (!m) throw new Error(`the answer names no saved copy: ${text}`)
  return { answer: text.slice(0, m.index), copy: m[1]! }
}
const lines = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const copies = (dir: string) => existsSync(join(dir, 'logs')) ? readdirSync(join(dir, 'logs')).filter(n => n.startsWith('text-')) : []

// The words each Telegram call that carries them gave Telegram, by the
// stand-in's log, as a copy's lines must hold them: the message id a send
// got, or the one an edit names, the method, and the text, the rich
// Markdown or the caption under the payload's own name.
const WORDED = ['sendMessage', 'sendRichMessage', 'sendDocument', 'sendMediaGroup', 'editMessageText', 'editMessageCaption']
function wire(cs: Call[]): object[] {
  return cs.filter(c => WORDED.includes(c.method) && !c.refused).flatMap(c => {
    const p = c.payload
    const rich = typeof p.rich_message === 'string' ? JSON.parse(p.rich_message) : p.rich_message
    const caption = c.method === 'sendMediaGroup' ? (typeof p.media === 'string' ? JSON.parse(p.media) : p.media)[0]?.caption : p.caption
    const words = rich?.markdown !== undefined ? { markdown: rich.markdown }
      : typeof p.text === 'string' ? { text: p.text, ...(p.parse_mode ? { parse_mode: p.parse_mode } : {}) }
      : typeof caption === 'string' ? { caption }
      : undefined
    if (!words) return []
    const id = c.method.startsWith('edit') ? Number(p.message_id) : c.message_id ?? (c as any).message_ids?.[0]
    return [{ method: c.method, message_id: id, ...words }]
  })
}
// A copy's lines without the envelope.
const worded = (path: string) => lines(path).map(({ at: _, pid: __, version: ___, tool: ____, chat: _____, ...rest }) => rest)
// The words of calls Telegram refused too, as a line marked unknown holds them.
const asSent = (cs: Call[]) => wire(cs.map(({ refused: _, ...c }) => c as Call))
// The server log's lines for calls through text_files, each naming a copy.
function named(dir: string, srv: Server): string[] {
  const log = join(dir, 'logs', `server-${srv.serverPid()}.jsonl`)
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(l => l.includes('text from ')) : []
}
// The time a copy's name carries, in ms.
function namedAt(copy: string): number {
  const m = /text-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-/.exec(copy)!
  const [y, mo, d, h, mi, s, ms] = m.slice(1).map(Number) as [number, number, number, number, number, number, number]
  return Date.UTC(y, mo - 1, d, h, mi, s, ms)
}

// The descriptors the server holds open on a path.
function openOn(srv: Server, paths: string[]): string[] {
  const fds = `/proc/${srv.serverPid()}/fd`
  return readdirSync(fds).flatMap(fd => {
    try {
      const target = readlinkSync(join(fds, fd))
      return paths.includes(target) ? [target] : []
    } catch { return [] }
  })
}

// A body in Markdown with a heading, a list, a table and a code block.
const BODY = [
  '## Weekly digest',
  'The week in **three** lines, with a [link](https://example.com) and `code`.',
  '- first item\n- second item',
  '| name | value |\n| --- | --- |\n| one | 1 |',
  '```\nplain block\n```',
].join('\n\n')

describe.skipIf(process.platform !== 'linux')('text_files: a message read from files', () => {
  for (const rich of [true, false]) {
    const mode = rich ? 'with rich messages on' : 'with rich messages off'
    const formats = rich ? [undefined, 'rich', 'text', 'markdownv2'] : [undefined, 'text', 'markdownv2']

    test(`${mode}, each call through text_files makes the Telegram calls and the answer typed text makes, and its copy holds the words of each message`, async () => {
      const dir = folder()
      const body = write(dir, 'body.md', BODY)
      const chart = write(dir, 'chart.png', 'png')
      const chart2 = write(dir, 'chart2.png', 'png')
      const a = write(dir, 'a.md', 'First section.')
      const b = write(dir, 'b.md', '- one\n- two')
      const c = write(dir, 'c.md', '## Third\n\nLast words.')
      const lf = write(dir, 'lf.md', 'Ends in line breaks.\n\n')
      const crlfEnds = write(dir, 'crlf-ends.md', 'Ends in CRLF line breaks.\r\n\r\n')
      const crlf = write(dir, 'crlf.md', 'One\r\ntwo\r\n\r\nthree')
      const bom = write(dir, 'bom.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Starts with a mark.')]))
      const long = write(dir, 'long.md', 'word '.repeat(300).trim())
      // Each step: the typed call's arguments, and the same with text_files.
      const steps: [string, object, object][] = [
        ...formats.map(format => ['reply', { chat_id: '1', text: BODY, format }, { chat_id: '1', text_files: [body], format }] as [string, object, object]),
        ['reply', { chat_id: String(BOT.id), text: BODY }, { chat_id: String(BOT.id), text_files: [body] }],
        ['reply', { chat_id: String(BOT.id), text: 'First section.', files: [chart] }, { chat_id: String(BOT.id), text_files: [a], files: [chart] }],
        ['reply', { chat_id: String(BOT.id), text: 'word '.repeat(300).trim(), files: [chart] }, { chat_id: String(BOT.id), text_files: [long], files: [chart] }],
        ['reply', { chat_id: '1', text: BODY, reply_to: '7', files: [chart] }, { chat_id: '1', text_files: [body], reply_to: '7', files: [chart] }],
        ['reply', { chat_id: '1', text: 'First section.\n\n- one\n- two\n\n## Third\n\nLast words.' }, { chat_id: '1', text_files: [a, b, c] }],
        ['reply', { chat_id: '1', text: 'Ends in line breaks.' }, { chat_id: '1', text_files: [lf] }],
        ['reply', { chat_id: '1', text: 'Ends in CRLF line breaks.' }, { chat_id: '1', text_files: [crlfEnds] }],
        ['reply', { chat_id: '1', text: 'One\ntwo\n\nthree' }, { chat_id: '1', text_files: [crlf] }],
        ['reply', { chat_id: '1', text: 'Starts with a mark.' }, { chat_id: '1', text_files: [bom] }],
        // Edits of the first message, a text, and of the bot's captioned file.
        ['edit_message', { chat_id: '1', message_id: '100', text: 'First section.' }, { chat_id: '1', message_id: '100', text_files: [a] }],
        ['edit_message', { chat_id: String(BOT.id), message_id: String(100 + formats.length + 1), text: 'Ends in line breaks.' }, { chat_id: String(BOT.id), message_id: String(100 + formats.length + 1), text_files: [lf] }],
        // A body typed text fails the same way: a caption over 1024 characters.
        ['edit_message', { chat_id: String(BOT.id), message_id: String(100 + formats.length + 1), text: 'word '.repeat(300).trim() }, { chat_id: String(BOT.id), message_id: String(100 + formats.length + 1), text_files: [long] }],
        // An album to a bot, its caption on the first document; last, so the
        // edits above keep their message ids.
        ['reply', { chat_id: String(BOT.id), text: 'First section.', files: [chart, chart2] }, { chat_id: String(BOT.id), text_files: [a], files: [chart, chart2] }],
      ]
      const typed = await sender({ rich })
      const filed = await sender({ rich })
      // Every copy line the steps saved, to see each kind of message among them.
      const saved: any[] = []
      for (const [name, typedArgs, filedArgs] of steps) {
        const t = await tool(typed.srv, name, typedArgs)
        const from = calls(filed.dir).length
        const f = await tool(filed.srv, name, filedArgs)
        expect(made(filed.dir)).toEqual(made(typed.dir))
        expect(f.isError).toBe(t.isError)
        const sent = wire(calls(filed.dir).slice(from))
        if (sent.length === 0) {
          // Nothing went, so no copy is named.
          expect(f.content[0].text).toBe(t.content[0].text)
          continue
        }
        const { answer, copy } = split(f.content[0].text)
        expect(answer).toBe(t.content[0].text)
        expect(worded(copy)).toEqual(sent)
        saved.push(...worded(copy))
        expect(lines(copy).every(l => l.tool === name && l.chat === (filedArgs as any).chat_id && typeof l.version === 'string')).toBe(true)
        expect(statSync(copy).mode & 0o777).toBe(0o600)
        expect(statSync(join(filed.dir, 'logs')).mode & 0o777).toBe(0o700)
      }
      // A rich part's Markdown, plain and MarkdownV2 text, a caption sent
      // and a caption and a text edited are each among them.
      const kinds = new Set(saved.map(l => `${l.method} ${Object.keys(l).filter(k => k !== 'method' && k !== 'message_id').sort().join(' ')}`))
      expect([...kinds].sort()).toEqual([
        ...(rich ? ['editMessageText markdown'] : ['editMessageText text']),
        'editMessageCaption caption',
        'sendDocument caption',
        'sendMediaGroup caption',
        'sendMessage parse_mode text',
        ...(rich ? ['sendRichMessage markdown'] : []),
        'sendMessage text',
      ].sort())
      // The caption edit went, and the long one was refused like typed text.
      expect(calls(filed.dir).filter(c => c.method === 'editMessageCaption').map(c => !!c.refused)).toEqual([false])
      // Typed text saves no copy.
      expect(copies(typed.dir)).toEqual([])
      // One server log line per call that sent, naming each file with its
      // size and sha256 and the copy, never the text.
      const log = readFileSync(join(filed.dir, 'logs', `server-${filed.srv.serverPid()}.jsonl`), 'utf8')
      const named = log.split('\n').filter(l => l.includes('text from '))
      expect(named.length).toBe(steps.length - 1)
      expect(log).toContain(`${body} (${BODY.length} bytes, sha256 ${new Bun.CryptoHasher('sha256').update(BODY).digest('hex')})`)
      expect(log).not.toContain('Weekly digest')
      expect(log).not.toContain('Last words')
      await typed.srv.close()
      await filed.srv.close()
    }, 60000)
  }

  test('in newline mode with a low chunk limit, a file with CRLF line breaks goes as the same text typed with LF, and each chunk is a line of the copy', async () => {
    const dir = folder()
    const paragraphs = ['alpha '.repeat(8).trim(), 'beta '.repeat(8).trim(), 'gamma '.repeat(8).trim()]
    const crlf = write(dir, 'crlf.md', paragraphs.join('\r\n\r\n') + '\r\n')
    const setup = { access: { textChunkLimit: 60, chunkMode: 'newline' } }
    const typed = await sender(setup)
    const filed = await sender(setup)
    const t = await tool(typed.srv, 'reply', { chat_id: '1', text: paragraphs.join('\n\n') })
    const f = await tool(filed.srv, 'reply', { chat_id: '1', text_files: [crlf] })
    expect(made(filed.dir)).toEqual(made(typed.dir))
    const { answer, copy } = split(f.content[0].text)
    expect(answer).toBe(t.content[0].text)
    expect(answer).toStartWith('sent 3 parts')
    expect(worded(copy)).toEqual(wire(calls(filed.dir)))
    expect(worded(copy).map((l: any) => l.text)).toEqual(paragraphs)
    await typed.srv.close()
    await filed.srv.close()
  }, 30000)

  test('a rich part Telegram refuses goes plain, and the copy holds the plain messages that went', async () => {
    const dir = folder()
    const body = write(dir, 'body.md', BODY)
    const REJECTED = { error_code: 400, description: 'Bad Request: RICH_MESSAGE_MARKDOWN_INVALID' }
    const setup = { rich: true, access: { textChunkLimit: 100 }, rules: [{ method: 'sendRichMessage', error: REJECTED }] }
    const typed = await sender(setup)
    const filed = await sender(setup)
    const t = await tool(typed.srv, 'reply', { chat_id: '1', text: BODY })
    const f = await tool(filed.srv, 'reply', { chat_id: '1', text_files: [body] })
    expect(made(filed.dir)).toEqual(made(typed.dir))
    const { answer, copy } = split(f.content[0].text)
    expect(answer).toBe(t.content[0].text)
    const went = worded(copy)
    expect(went.length).toBeGreaterThan(1)
    expect(went.every((l: any) => l.method === 'sendMessage')).toBe(true)
    expect(went).toEqual(wire(calls(filed.dir)))
    await typed.srv.close()
    await filed.srv.close()
  }, 30000)

  test('a reply that stops part way names its copy, which holds the messages that went; one whose delivery is unknown marks that message so', async () => {
    const dir = folder()
    const paragraphs = ['one '.repeat(10).trim(), 'two '.repeat(10).trim(), 'three '.repeat(10).trim()]
    const body = write(dir, 'body.md', paragraphs.join('\n\n'))
    const TOO_MANY = { error_code: 429, description: 'Too Many Requests: retry after 5', parameters: { retry_after: 5 } }
    const BAD_GATEWAY = { error_code: 502, description: 'Bad Gateway' }
    const access = { textChunkLimit: 50, chunkMode: 'newline' }
    // A refusal of the second message: the first went.
    const stopped = await sender({ access, rules: [{ method: 'sendMessage', skip: 1, times: 1, error: TOO_MANY }] })
    const r1 = await tool(stopped.srv, 'reply', { chat_id: '1', text_files: [body] })
    expect(r1.isError).toBe(true)
    const s1 = split(r1.content[0].text)
    expect(s1.answer).toContain('part 2')
    expect(worded(s1.copy)).toEqual([{ method: 'sendMessage', message_id: 100, text: paragraphs[0] }])
    // Telegram answers the second with a 5xx: it may still arrive.
    const unknown = await sender({ access, rules: [{ method: 'sendMessage', skip: 1, times: 1, error: BAD_GATEWAY }] })
    const r2 = await tool(unknown.srv, 'reply', { chat_id: '1', text_files: [body] })
    const s2 = split(r2.content[0].text)
    expect(s2.answer).toContain('delivery unknown')
    expect(worded(s2.copy)).toEqual([
      { method: 'sendMessage', message_id: 100, text: paragraphs[0] },
      { method: 'sendMessage', delivery: 'unknown', text: paragraphs[1] },
    ])
    // Nothing went: the first message refused, so no copy and no path.
    const refused = await sender({ access, rules: [{ method: 'sendMessage', error: TOO_MANY }] })
    const r3 = await tool(refused.srv, 'reply', { chat_id: '1', text_files: [body] })
    expect(r3.isError).toBe(true)
    expect(r3.content[0].text).not.toContain('saved')
    expect(copies(refused.dir)).toEqual([])
    // The server log names a copy for each call that put out a message, or
    // may have, and none for the call that put out nothing.
    expect(named(stopped.dir, stopped.srv)).toEqual([expect.stringContaining(`; its copy: ${s1.copy}`)])
    expect(named(unknown.dir, unknown.srv)).toEqual([expect.stringContaining(`; its copy: ${s2.copy}`)])
    expect(named(refused.dir, refused.srv)).toEqual([])
    for (const s of [stopped, unknown, refused]) await s.srv.close()
  }, 30000)

  test('an edit whose outcome is unknown names its copy, whose line holds the message id and the text marked unknown; an edit Telegram refuses names none and logs none', async () => {
    const dir = folder()
    const chart = write(dir, 'chart.png', 'png')
    const body = write(dir, 'body.md', 'New **text**.')
    const BAD_GATEWAY = { error_code: 502, description: 'Bad Gateway' }
    // Each case: rich messages on or off, the edit's method, and whether the
    // message is a bot's captioned file.
    const cases: [boolean, string, boolean][] = [
      [false, 'editMessageText', false],
      [true, 'editMessageText', false],
      [false, 'editMessageCaption', true],
    ]
    for (const [rich, method, captioned] of cases) {
      const s = await sender({ rich, rules: [{ method, error: BAD_GATEWAY }] })
      const chat_id = captioned ? String(BOT.id) : '1'
      const sent = await tool(s.srv, 'reply', captioned ? { chat_id, text: 'Old caption.', files: [chart] } : { chat_id, text: 'Old text.' })
      const id = Number(/id: (\d+)/.exec(sent.content[0].text)![1])
      const from = calls(s.dir).length
      const r = await tool(s.srv, 'edit_message', { chat_id, message_id: String(id), text_files: [body] })
      expect(r.isError).toBeUndefined()
      expect(r.content[0].text).toContain('edit outcome unknown')
      const { copy } = split(r.content[0].text)
      const edits = asSent(calls(s.dir).slice(from))
      expect(edits).toEqual([expect.objectContaining({ method, message_id: id })])
      expect(worded(copy)).toEqual([{ ...edits[0], delivery: 'unknown' }])
      expect(named(s.dir, s.srv)).toEqual([expect.stringContaining(`; its copy: ${copy}`)])
      await s.srv.close()
    }
    // Refused: nothing changed, so no copy and no log line names one.
    const NOT_FOUND = { error_code: 400, description: 'Bad Request: message to edit not found' }
    const refused = await sender({ rules: [{ method: 'editMessageText', error: NOT_FOUND }] })
    await tool(refused.srv, 'reply', { chat_id: '1', text: 'Old text.' })
    const r = await tool(refused.srv, 'edit_message', { chat_id: '1', message_id: '100', text_files: [body] })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).not.toContain('saved')
    expect(copies(refused.dir)).toEqual([])
    expect(named(refused.dir, refused.srv)).toEqual([])
    await refused.srv.close()
  }, 30000)

  test('an edit the 10-second limit gives up on names its copy, whose line holds the message id and the rich text marked unknown, before the answer', async () => {
    driveClock()
    const dir = folder()
    const body = write(dir, 'body.md', 'New **text**.')
    const { dir: stateDir, srv } = await channel({ rich: true, rules: [{ method: 'editMessageText', holdMs: 15000 }] })
    const sent = await tool(srv, 'reply', { chat_id: '1', text: 'Old text.' })
    const id = Number(/id: (\d+)/.exec(sent.content[0].text)![1])
    // The answer comes after the 10-second limit, past request's default wait.
    const r = (await srv.request('tools/call', { name: 'edit_message', arguments: { chat_id: '1', message_id: String(id), text_files: [body], buttons: [['Yes', 'No']] } }, 20000)).result
    expect(r.content[0].text).toContain('edit outcome unknown')
    const { copy } = split(r.content[0].text)
    const edits = wire(calls(stateDir).filter(c => c.method === 'editMessageText'))
    expect(edits.length).toBe(1)
    expect(worded(copy)).toEqual([{ ...edits[0], delivery: 'unknown' }])
    await srv.close()
  }, 40000)

  test('a rich edit Telegram refuses goes plain, as typed text does, and the copy holds the plain text that went', async () => {
    const dir = folder()
    const body = write(dir, 'body.md', 'New **text**.')
    const REJECTED = { error_code: 400, description: 'Bad Request: RICH_MESSAGE_MARKDOWN_INVALID' }
    const setup = { rich: true, rules: [{ method: 'editMessageText', has: 'rich_message', times: 1, error: REJECTED }] }
    const typed = await sender(setup)
    const filed = await sender(setup)
    for (const s of [typed, filed]) await tool(s.srv, 'reply', { chat_id: '1', text: 'Old text.' })
    const t = await tool(typed.srv, 'edit_message', { chat_id: '1', message_id: '100', text: 'New **text**.' })
    const from = calls(filed.dir).length
    const f = await tool(filed.srv, 'edit_message', { chat_id: '1', message_id: '100', text_files: [body] })
    expect(made(filed.dir)).toEqual(made(typed.dir))
    // The rich call was refused, and its plain fallback went.
    expect(calls(filed.dir).slice(from).map(c => [c.method, !!c.refused])).toEqual([['editMessageText', true], ['editMessageText', false]])
    const { answer, copy } = split(f.content[0].text)
    expect(answer).toBe(t.content[0].text)
    const went = worded(copy)
    expect(went).toEqual(wire(calls(filed.dir).slice(from)))
    expect(went).toEqual([expect.objectContaining({ method: 'editMessageText', message_id: 100, text: expect.any(String) })])
    expect(went[0]).not.toHaveProperty('markdown')
    await typed.srv.close()
    await filed.srv.close()
  }, 30000)

  test('the copy is named by the time the call began, before any lookup', async () => {
    const dir = folder()
    const body = write(dir, 'body.md', 'To the bot.')
    // The bot's lookup takes half a second.
    const { dir: stateDir, srv } = await sender({ rules: [{ method: 'getChatMember', holdMs: 500 }] })
    const r = await tool(srv, 'reply', { chat_id: String(BOT.id), text_files: [body] })
    const { copy } = split(r.content[0].text)
    const lookup = calls(stateDir).find(c => c.method === 'getChatMember')!
    expect(namedAt(copy)).toBeLessThanOrEqual(lookup.at)
    await srv.close()
  }, 30000)

  test('a message Telegram delivered to another chat than the one asked for is saved under the chat it went to', async () => {
    const dir = folder()
    const body = write(dir, 'body.md', 'second')
    // From its second send on, the bot's username answers chat 9998; the
    // first send waits, so the second reply needs no lookup.
    const { dir: stateDir, srv } = await sender({ chats: { redirect: { username: BOT.username, to: 9998, from: 2, ids: 600 }, hold: { send: 1, ms: 1500 } } })
    const first = tool(srv, 'reply', { chat_id: String(BOT.id), text: 'first' })
    await until(() => calls(stateDir).some(c => c.method === 'sendMessage'))
    const r = await tool(srv, 'reply', { chat_id: String(BOT.id), text_files: [body] })
    expect(r.isError).toBe(true)
    const { answer, copy } = split(r.content[0].text)
    expect(answer).toBe(`reply failed: reply failed after 1 of 1 message(s) sent (ids: 601): message 601 went to chat 9998, not ${BOT.id}`)
    expect(lines(copy).map(l => [l.chat, l.method, l.message_id, l.text])).toEqual([['9998', 'sendMessage', 601, 'second']])
    await first
    await srv.close()
  }, 30000)

  test('reply_to, buttons and files through text_files make the calls and answer typed text makes, the buttons on the last message', async () => {
    driveClock()
    const dir = folder()
    const body = write(dir, 'body.md', BODY)
    const chart = write(dir, 'chart.png', 'png')
    const typed = await channel()
    const filed = await channel()
    const args = { chat_id: '1', reply_to: '7', files: [chart], buttons: [['Yes', 'No']] }
    const t = await tool(typed.srv, 'reply', { ...args, text: BODY })
    const from = calls(filed.dir).length
    const f = await tool(filed.srv, 'reply', { ...args, text_files: [body] })
    // A keyboard's id comes from the clock, which moved between the two.
    const sends = (d: string) => made(d).filter(c => c.method.startsWith('send'))
      .map(c => JSON.parse(JSON.stringify(c).replace(/btn:\d+:/g, 'btn:<keyboard>:')))
    expect(sends(filed.dir)).toEqual(sends(typed.dir))
    const { answer, copy } = split(f.content[0].text)
    expect(answer).toBe(t.content[0].text)
    expect(answer).toContain('; buttons on message')
    expect(worded(copy)).toEqual(wire(calls(filed.dir).slice(from)))
    await typed.srv.close()
    await filed.srv.close()
  }, 30000)

  test('once the copies pass 64 MiB in all, a new copy deletes the oldest others first', async () => {
    const dir = folder()
    const body = write(dir, 'body.md', 'A short message.')
    const { dir: state, srv } = await sender()
    const logs = join(state, 'logs')
    mkdirSync(logs, { recursive: true })
    // Copies left by earlier calls, as sparse files of 24 MiB each, oldest
    // first; an older log file of another kind is no copy.
    const old = ['text-20261101T000000000Z-1-1.jsonl', 'text-20261102T000000000Z-1-2.jsonl', 'text-20261103T000000000Z-1-3.jsonl']
    const other = join(logs, 'server-1.jsonl')
    writeFileSync(other, '')
    old.forEach((name, i) => {
      const path = join(logs, name)
      writeFileSync(path, '')
      truncateSync(path, 24 * 1024 * 1024)
      const at = new Date(Date.UTC(2026, 10, 1 + i))
      execFileSync('touch', ['-d', at.toISOString(), path])
    })
    execFileSync('touch', ['-d', '2026-10-01T00:00:00Z', other])
    const r = await tool(srv, 'reply', { chat_id: '1', text_files: [body] })
    const { copy } = split(r.content[0].text)
    const left = copies(state).sort()
    // 72 MiB and the new copy: the oldest goes, and the other two stay.
    expect(left).toEqual([...old.slice(1), copy.split('/').pop()!].sort())
    expect(existsSync(other)).toBe(true)
    expect(left.reduce((sum, n) => sum + statSync(join(logs, n)).size, 0)).toBeLessThanOrEqual(COPIES_MAX)
    await srv.close()
  }, 30000)

  test.skipIf(process.getuid?.() === 0)('a copy that cannot be written leaves the message sent and the answer saying why the words were not saved', async () => {
    const dir = folder()
    const body = write(dir, 'body.md', 'A short message.')
    const { dir: state, srv } = await sender()
    // A typed reply first, so the server's log and call record exist; a new
    // file in the folder is then refused.
    expect((await tool(srv, 'reply', { chat_id: '1', text: 'typed' })).content[0].text).toBe('sent (id: 100)')
    const logs = join(state, 'logs')
    chmodSync(logs, 0o500)
    try {
      const r = await tool(srv, 'reply', { chat_id: '1', text_files: [body] })
      expect(r.isError).toBeUndefined()
      expect(r.content[0].text).toMatch(/^sent \(id: 101\); the words sent were not saved: EACCES/)
      expect(calls(state).filter(c => c.method === 'sendMessage').map(c => c.payload.text)).toEqual(['typed', 'A short message.'])
    } finally {
      chmodSync(logs, 0o700)
    }
    expect(copies(state)).toEqual([])
    // The server log still names the copy the call meant to write.
    expect(named(state, srv)).toEqual([expect.stringMatching(/; its copy: \/\S+\/logs\/text-\d{8}T\d{9}Z-\d+-\d+\.jsonl"/)])
    await srv.close()
  }, 30000)

  test('each refusal names its reason, and the path where there is one, never the content, and makes no Telegram call, no button reservation and no copy, and leaves no file open', async () => {
    driveClock()
    const dir = folder()
    const { dir: stateDir, srv } = await channel()
    const good = write(dir, 'good.md', 'Good text.')
    const secret = 'SECRET-CONTENT'
    const pipe = join(dir, 'pipe.md')
    execFileSync('mkfifo', [pipe])
    const intoState = join(dir, 'into-state.md')
    symlinkSync(join(stateDir, 'access.json'), intoState)
    const big = write(dir, 'big.md', 'x'.repeat(200 * 1024))
    const big2 = write(dir, 'big2.md', 'y'.repeat(200 * 1024))
    const over = write(dir, 'over.md', 'z'.repeat(TEXT_FILES_MAX + 1))
    const badUtf8 = write(dir, 'bad.md', Buffer.from([0x61, 0xc3, 0x28, ...Buffer.from(secret)]))
    const utf16 = write(dir, 'utf16.md', Buffer.from(`${secret} in UTF-16`, 'utf16le'))
    const empty = write(dir, 'empty.md', '')
    const bomOnly = write(dir, 'bom-only.md', Buffer.from([0xef, 0xbb, 0xbf]))
    const blank = write(dir, 'blank.md', ' \n\t\r\n ')
    const buttons = [['Yes', 'No']]
    const sent = 'nothing was sent'
    // Each case: the tool, its arguments, and what its refusal must say.
    const cases: [string, object, string[]][] = [
      ['reply', { chat_id: '1', text: 'x', text_files: [good], buttons }, [`pass text or text_files, not both, so ${sent}`]],
      ['reply', { chat_id: '1', text: '', text_files: [good], buttons }, [`pass text or text_files, not both, so ${sent}`]],
      ['reply', { chat_id: '1', buttons }, [`pass text or text_files, so ${sent}`]],
      ['reply', { chat_id: '1', text_files: good, buttons }, ['text_files must be a non-empty list of absolute paths', sent]],
      ['reply', { chat_id: '1', text_files: [], buttons }, ['text_files must be a non-empty list of absolute paths', sent]],
      ['reply', { chat_id: '1', text_files: [5], buttons }, ['text_files must be a non-empty list of absolute paths', sent]],
      ['reply', { chat_id: '1', text_files: null, buttons }, ['text_files must be a non-empty list of absolute paths', sent]],
      ['reply', { chat_id: '1', text: 5, buttons }, [`text must be a string, so ${sent}`]],
      ['reply', { chat_id: '1', text: null, buttons }, [`text must be a string, so ${sent}`]],
      ['reply', { chat_id: '1', text_files: ['good.md'], buttons }, ['good.md is not an absolute path', sent]],
      ['reply', { chat_id: '1', text_files: [good, join(dir, 'missing.md')], buttons }, [`${join(dir, 'missing.md')} does not resolve (ENOENT)`, sent]],
      ['reply', { chat_id: '1', text_files: [join(stateDir, 'access.json')], buttons }, [`refusing to send channel state: ${join(stateDir, 'access.json')}`, sent]],
      ['reply', { chat_id: '1', text_files: [intoState], buttons }, [`refusing to send channel state: ${intoState}`, sent]],
      ['reply', { chat_id: '1', text_files: [dir], buttons }, [`${dir} is not a regular file`, sent]],
      ['reply', { chat_id: '1', text_files: [pipe], buttons }, [`${pipe} is not a regular file`, sent]],
      ['reply', { chat_id: '1', text_files: ['/dev/zero'], buttons }, ['/dev/zero is not a regular file', sent]],
      ['reply', { chat_id: '1', text_files: [big, big2], buttons }, [`${big2} takes the call's files over 256 KiB`, sent]],
      ['reply', { chat_id: '1', text_files: [over], buttons }, [`${over} takes the call's files over 256 KiB`, sent]],
      // A file that reports no size: read only up to what the call has left.
      ['reply', { chat_id: '1', text_files: [big, '/proc/kallsyms'], buttons }, ["/proc/kallsyms takes the call's files over 256 KiB", sent]],
      ['reply', { chat_id: '1', text_files: [badUtf8], buttons }, [`${badUtf8} is not UTF-8 text`, sent]],
      ['reply', { chat_id: '1', text_files: [utf16], buttons }, [`${utf16} holds a NUL byte`, sent]],
      ['reply', { chat_id: '1', text_files: [empty], buttons }, [`${empty} holds no text`, sent]],
      ['reply', { chat_id: '1', text_files: [bomOnly], buttons }, [`${bomOnly} holds no text`, sent]],
      ['reply', { chat_id: '1', text_files: [blank], buttons }, [`${blank} holds no text`, sent]],
      ['edit_message', { chat_id: '1', message_id: '7' }, ['pass text or text_files, buttons, or both']],
      ['edit_message', { chat_id: '1', message_id: '7', text: 'x', text_files: [good] }, ['pass text or text_files, not both, so nothing was edited']],
      ['edit_message', { chat_id: '1', message_id: '7', text_files: [blank], buttons }, [`${blank} holds no text`, 'nothing was edited']],
    ]
    const paths = [dir, good, pipe, big, big2, over, badUtf8, utf16, empty, bomOnly, blank, '/proc/kallsyms', '/dev/zero', join(stateDir, 'access.json')]
    const before = calls(stateDir).length
    for (const [name, args, says] of cases) {
      const r = await tool(srv, name, args)
      expect(r.isError).toBe(true)
      for (const s of says) expect(r.content[0].text).toContain(s)
      expect(r.content[0].text).not.toContain(secret)
      expect(r.content[0].text).not.toContain('saved')
      expect(openOn(srv, paths)).toEqual([])
    }
    // No send or edit, and no buttons reserved.
    expect(calls(stateDir).slice(before).filter(c => c.method !== 'getUpdates' && c.method !== 'sendChatAction')).toEqual([])
    const record = existsSync(join(stateDir, 'buttons.json')) ? JSON.parse(readFileSync(join(stateDir, 'buttons.json'), 'utf8')) : { entries: [] }
    expect(record.entries).toEqual([])
    expect(copies(stateDir)).toEqual([])
    await srv.close()
  }, 60000)

  test('an inbox file and a file reached through a link that resolves outside the state folder are sent; files keeps its rule', async () => {
    const dir = folder()
    const { dir: stateDir, srv } = await sender()
    mkdirSync(join(stateDir, 'inbox'))
    const inbox = write(join(stateDir, 'inbox'), 'note.md', 'From the inbox.')
    const target = write(dir, 'target.md', 'Through a link.')
    const link = join(dir, 'link.md')
    symlinkSync(target, link)
    expect(split((await tool(srv, 'reply', { chat_id: '1', text_files: [inbox] })).content[0].text).answer).toBe('sent (id: 100)')
    expect(split((await tool(srv, 'reply', { chat_id: '1', text_files: [link] })).content[0].text).answer).toBe('sent (id: 101)')
    expect(calls(stateDir).filter(c => c.method === 'sendMessage').map(c => c.payload.text)).toEqual(['From the inbox.', 'Through a link.'])
    // files: the state folder and a link into it refused, an inbox file sent,
    // a missing path failing as before.
    const intoState = join(dir, 'into-state')
    symlinkSync(join(stateDir, 'access.json'), intoState)
    const sends = calls(stateDir).length
    for (const f of [join(stateDir, 'access.json'), intoState]) {
      const r = await tool(srv, 'reply', { chat_id: '1', text: 'x', files: [f] })
      expect(r.isError).toBe(true)
      expect(r.content[0].text).toBe(`reply failed: refusing to send channel state: ${f}`)
    }
    expect(calls(stateDir).length).toBe(sends)
    const sent = await tool(srv, 'reply', { chat_id: '1', text: 'the note', files: [inbox] })
    expect(sent.content[0].text).toBe('sent 2 parts (ids: 102, 103); what each holds: 102 text, 103 file')
    const missing = await tool(srv, 'reply', { chat_id: '1', text: 'x', files: [join(dir, 'missing.png')] })
    expect(missing.isError).toBe(true)
    expect(missing.content[0].text).toContain('ENOENT')
    // The rule compares at a folder's boundary: a state folder whose name
    // only starts like the inbox's is refused through both arguments, and a
    // folder beside the state folder whose name starts like it is sent.
    mkdirSync(join(stateDir, 'inbox-old'))
    const lookalike = write(join(stateDir, 'inbox-old'), 'note.md', 'Not from the inbox.')
    const sibling = `${stateDir}-sibling`
    mkdirSync(sibling)
    folders.push(sibling)
    const beside = write(sibling, 'x.md', 'Beside the state folder.')
    const before = calls(stateDir).length
    const viaText = await tool(srv, 'reply', { chat_id: '1', text_files: [lookalike] })
    expect(viaText.isError).toBe(true)
    expect(viaText.content[0].text).toContain(`refusing to send channel state: ${lookalike}`)
    const viaFiles = await tool(srv, 'reply', { chat_id: '1', text: 'x', files: [lookalike] })
    expect(viaFiles.content[0].text).toBe(`reply failed: refusing to send channel state: ${lookalike}`)
    expect(calls(stateDir).length).toBe(before)
    expect(split((await tool(srv, 'reply', { chat_id: '1', text_files: [beside] })).content[0].text).answer).toBe('sent (id: 104)')
    expect((await tool(srv, 'reply', { chat_id: '1', text: 'beside', files: [beside] })).content[0].text).toBe('sent 2 parts (ids: 105, 106); what each holds: 105 text, 106 file')
    await srv.close()
  }, 30000)

  test('the tools list text_files, reply no longer requires text, and the server instructions name it', async () => {
    const { srv } = await sender()
    const { tools } = (await srv.request('tools/list', {})).result
    const reply = tools.find((t: any) => t.name === 'reply')
    const edit = tools.find((t: any) => t.name === 'edit_message')
    expect(reply.inputSchema.required).toEqual(['chat_id'])
    expect(reply.inputSchema.properties.text_files.type).toBe('array')
    expect(edit.inputSchema.properties.text_files).toEqual(reply.inputSchema.properties.text_files)
    expect(reply.description).toContain('text_files')
    expect(edit.description).toContain('text_files')
    const init = await srv.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    expect(init.result.instructions).toContain('goes by the text_files argument of reply and edit_message, never typed again')
    await srv.close()
  }, 30000)
})
