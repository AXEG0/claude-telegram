import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { calls, cleanup, start, state, type Call, type Server } from './fixtures/harness.ts'

afterEach(cleanup)

// The owner and another bot on the allowlist.
const BOT = { id: 9000001, is_bot: true, first_name: 'Peer', username: 'peer_bot' }
const ACCESS = { dmPolicy: 'allowlist', allowFrom: ['1', String(BOT.id)] }

// The server of a session that does not poll: it calls Telegram only for
// what a tool asks.
async function sender(rich: boolean, o: { access?: object; rules?: object[] } = {}): Promise<{ dir: string; srv: Server }> {
  const dir = state({ ...ACCESS, ...o.access })
  const srv = start(dir, ['claude', '-p', 'hello'], {
    TELEGRAM_RICH_MESSAGES: String(rich),
    TELEGRAM_TEST_USERS: JSON.stringify({ [BOT.id]: BOT }),
    TELEGRAM_TEST_CHATS: JSON.stringify({ ids: 100 }),
    ...(o.rules ? { TELEGRAM_TEST_RULES: JSON.stringify(o.rules) } : {}),
  })
  await srv.ready()
  return { dir, srv }
}
const tool = async (srv: Server, name: string, args: object) =>
  (await srv.request('tools/call', { name, arguments: args })).result
// The format property reply and edit_message declare.
async function declared(srv: Server): Promise<Record<string, any>> {
  const { tools } = (await srv.request('tools/list', {})).result
  return Object.fromEntries(tools.filter((t: any) => t.name === 'reply' || t.name === 'edit_message')
    .map((t: any) => [t.name, t.inputSchema.properties.format]))
}
// How Telegram was asked to show a send or an edit.
const styleOf = (c: Call) =>
  c.method === 'sendRichMessage' || c.payload.rich_message !== undefined ? 'rich'
    : c.payload.parse_mode === 'MarkdownV2' ? 'markdownv2'
    : c.payload.parse_mode === undefined ? 'text' : `parse_mode ${c.payload.parse_mode}`

describe.skipIf(process.platform !== 'linux')('the format of reply and edit_message', () => {
  for (const rich of [true, false]) {
    const mode = rich ? 'with rich messages on' : 'with rich messages off'
    const list = rich ? ['rich', 'text', 'markdownv2'] : ['text', 'markdownv2']

    test(`${mode}, a format the schema does not list is refused, naming it and the list, and Telegram gets no call`, async () => {
      const { dir, srv } = await sender(rich)
      const format = await declared(srv)
      expect(format.reply.enum).toEqual(list)
      expect(format.edit_message).toEqual(format.reply)
      const refused: unknown[] = ['markdown', 'MarkdownV2', 'html', '', 5, null, ...(rich ? [] : ['rich'])]
      const cases: [string, string, object][] = [
        ['reply', 'nothing was sent', { chat_id: '1', text: '**bold**' }],
        // Another bot's chat: refused before the server asks Telegram about it.
        ['reply', 'nothing was sent', { chat_id: String(BOT.id), text: '**bold**' }],
        // Buttons, which this server would refuse.
        ['reply', 'nothing was sent', { chat_id: '1', text: 'Merge?', buttons: [['Yes', 'No']] }],
        ['edit_message', 'nothing was edited', { chat_id: '1', message_id: '7', text: '**bold**' }],
        // New buttons, which this server would refuse, and an edit of the buttons alone.
        ['edit_message', 'nothing was edited', { chat_id: '1', message_id: '7', text: 'Merge?', buttons: [['Yes', 'No']] }],
        ['edit_message', 'nothing was edited', { chat_id: '1', message_id: '7', buttons: [] }],
        // Another bot's chat, never asked about.
        ['edit_message', 'nothing was edited', { chat_id: String(BOT.id), message_id: '7', text: '**bold**' }],
      ]
      for (const value of refused) {
        for (const [name, undone, args] of cases) {
          const r = await tool(srv, name, { ...args, format: value })
          expect(r.isError).toBe(true)
          expect(r.content[0].text).toBe(
            `${name} failed: format ${JSON.stringify(value)} is not one of ${list.join(', ')}, so ${undone}. ${format.reply.description}`,
          )
        }
      }
      expect(calls(dir)).toEqual([])
      await srv.close()
    }, 20000)

    test(`${mode}, a reply with a file to a person answers what each message holds, in each listed format`, async () => {
      const { dir, srv } = await sender(rich)
      mkdirSync(join(dir, 'inbox'))
      const chart = join(dir, 'inbox', 'chart.png')
      writeFileSync(chart, 'png')
      for (const format of list) {
        const from = calls(dir).length
        const r = await tool(srv, 'reply', { chat_id: '1', text: `**the chart** in ${format}`, files: [chart], format })
        const sent = calls(dir).slice(from).filter(c => c.method.startsWith('send'))
        expect(sent.map(c => c.method)).toEqual([format === 'rich' ? 'sendRichMessage' : 'sendMessage', 'sendPhoto'])
        const [text, photo] = sent.map(c => c.message_id!)
        expect(text).not.toBe(photo)
        expect(r.content[0].text).toBe(`sent 2 parts (ids: ${text}, ${photo}); what each holds: ${text} text, ${photo} file`)
      }
      await srv.close()
    }, 20000)

    test(`${mode}, a reply with a file to a person whose text goes as several messages answers what each of them holds, in each listed format`, async () => {
      // Chunks of 10 characters; a rich part Telegram refuses goes out as plain chunks.
      const REJECTED = { error_code: 400, description: 'Bad Request: RICH_MESSAGE_MARKDOWN_INVALID' }
      const { dir, srv } = await sender(rich, { access: { textChunkLimit: 10 }, rules: [{ method: 'sendRichMessage', error: REJECTED }] })
      mkdirSync(join(dir, 'inbox'))
      const chart = join(dir, 'inbox', 'chart.png')
      writeFileSync(chart, 'png')
      for (const format of list) {
        const from = calls(dir).length
        const r = await tool(srv, 'reply', { chat_id: '1', text: 'a'.repeat(10) + 'b'.repeat(10), files: [chart], format })
        const made = calls(dir).slice(from).filter(c => c.method.startsWith('send'))
        expect(made.map(c => [c.method, c.refused])).toEqual([
          ...(format === 'rich' ? [['sendRichMessage', REJECTED.description]] : []),
          ['sendMessage', undefined], ['sendMessage', undefined], ['sendPhoto', undefined],
        ])
        const [a, b, c] = made.filter(m => !m.refused).map(m => m.message_id!)
        expect(new Set([a, b, c]).size).toBe(3)
        expect(r.content[0].text).toBe(`sent 3 parts (ids: ${a}, ${b}, ${c}); what each holds: ${a} text, ${b} text, ${c} file`)
      }
      await srv.close()
    }, 20000)

    test(`${mode}, each listed format and none send and edit as before, and a bot's chat gets plain text`, async () => {
      const { dir, srv } = await sender(rich)
      const format = await declared(srv)
      const fallback = rich ? 'rich' : 'text'
      const asked: [unknown, string][] = [[undefined, fallback], ...format.reply.enum.map((f: string) => [f, f] as [string, string])]
      for (const [value, style] of asked) {
        const text = `**${String(value)}**`
        const withFormat = value === undefined ? {} : { format: value }
        for (const [name, args] of [
          ['reply', { chat_id: '1', text }],
          ['edit_message', { chat_id: '1', message_id: '7', text }],
          ['reply', { chat_id: String(BOT.id), text }],
          ['edit_message', { chat_id: String(BOT.id), message_id: '7', text }],
        ] as [string, object][]) {
          const from = calls(dir).length
          const r = await tool(srv, name, { ...args, ...withFormat })
          expect(r.isError).not.toBe(true)
          const made = calls(dir).slice(from).filter(c => c.method !== 'getChatMember')
          expect(made).toHaveLength(1)
          const toBot = String((args as any).chat_id) === String(BOT.id)
          expect([made[0]!.method.startsWith('edit') ? 'edit' : 'send', styleOf(made[0]!)])
            .toEqual([name === 'reply' ? 'send' : 'edit', toBot ? 'text' : style])
          if (toBot) expect(made[0]!.payload.text).toBe(text)
        }
      }
      await srv.close()
    }, 20000)
  }

  test('with rich messages on, a table right under a paragraph gets a blank line in a reply and an edit; a bot gets the text as written', async () => {
    const { dir, srv } = await sender(true)
    const text = '**The real risks**\n| Risk | Impact |\n|---|---|\n| a | b |'
    const fixed = '**The real risks**\n\n| Risk | Impact |\n|---|---|\n| a | b |'
    for (const [name, args] of [
      ['reply', { chat_id: '1', text }],
      ['edit_message', { chat_id: '1', message_id: '7', text }],
      ['reply', { chat_id: String(BOT.id), text }],
      ['edit_message', { chat_id: String(BOT.id), message_id: '7', text }],
    ] as [string, any][]) {
      const from = calls(dir).length
      const r = await tool(srv, name, args)
      expect(r.isError).not.toBe(true)
      const made = calls(dir).slice(from).filter(c => c.method !== 'getChatMember')
      expect(made).toHaveLength(1)
      if (args.chat_id === '1') expect(made[0]!.payload.rich_message).toEqual({ markdown: fixed })
      else expect([styleOf(made[0]!), made[0]!.payload.text]).toEqual(['text', text])
    }
    await srv.close()
  }, 20000)
})
