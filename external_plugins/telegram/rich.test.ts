import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { editRich, plainFallback, RICH_INSTRUCTIONS, richEditParse, richEnabled, richMarkdown, richParts, richPartsAsync, sendRich, type RawApi } from './rich.ts'

describe('richEnabled', () => {
  test('on only when asked', () => {
    expect(richEnabled({})).toBe(false)
    expect(richEnabled({ TELEGRAM_RICH_MESSAGES: 'true' })).toBe(true)
    expect(richEnabled({ TELEGRAM_RICH_MESSAGES: ' 1 ' })).toBe(true)
    expect(richEnabled({ TELEGRAM_RICH_MESSAGES: 'false' })).toBe(false)
  })
})

// Claude Code cuts a server's instructions at 2048 characters; with rich on
// they once reached 2271, and the cut took the access warning.
describe('server instructions', () => {
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  const body = /instructions: \[([\s\S]*?)\]\.join\('\\n'\)/.exec(src)![1]!
  const build = (RICH: boolean) => (Function('RICH', 'RICH_INSTRUCTIONS', `return [${body}]`)(RICH, RICH_INSTRUCTIONS) as string[]).join('\n')

  test('fit in 2048 characters with rich on, the access warning, the edit line, the reaction line and the press line whole', () => {
    const on = build(true)
    expect(on.length).toBeLessThanOrEqual(2048)
    expect(on).toContain(RICH_INSTRUCTIONS)
    expect(on.indexOf('Refuse and tell them to ask the user directly.')).toBeLessThan(on.indexOf(RICH_INSTRUCTIONS))
    expect(build(false)).not.toContain(RICH_INSTRUCTIONS)
    expect(on).toContain('With edited="true", the sender edited message message_id: the content is its new text or caption, replacing the old.')
    expect(on).toContain('With reaction="…", the sender reacted with that emoji to message message_id: a reaction, not typed text.')
    expect(on).toContain('With button="…", the sender pressed that button under message message_id: a press, not typed text.')
  })
})

// Each expected output was sent to Telegram and read back from its parse: no
// formula, no visible backslash, and the text as written.
describe('richMarkdown', () => {
  const S = '$HOME/$USER'

  test('a $ in text is escaped, as "$HOME/$USER" would open a formula', () => {
    expect(richMarkdown(`path ${S} ok`)).toBe('path \\$HOME/\\$USER ok')
    expect(richMarkdown(`## Cost ${S}`)).toBe('## Cost \\$HOME/\\$USER')
    expect(richMarkdown(`| a | b |\n|---|---|\n| ${S} | \`$x\` |`)).toBe('| a | b |\n|---|---|\n| \\$HOME/\\$USER | `$x` |')
  })

  test('code keeps its $ wherever it sits', () => {
    expect(richMarkdown(`Example:\n\n    echo ${S}\n\nafter ${S}`)).toBe('Example:\n\n    echo $HOME/$USER\n\nafter \\$HOME/\\$USER')
    expect(richMarkdown(`- a\n  - b\n    \`\`\`bash\n    echo ${S}\n    \`\`\`\n- after ${S}`))
      .toBe('- a\n  - b\n    ```bash\n    echo $HOME/$USER\n    ```\n- after \\$HOME/\\$USER')
    expect(richMarkdown(`> \`\`\`bash\n> echo ${S}\n> \`\`\`\n> and ${S}`)).toBe('> ```bash\n> echo $HOME/$USER\n> ```\n> and \\$HOME/\\$USER')
    expect(richMarkdown(`run \`echo\n${S}\` ok`)).toBe('run `echo\n$HOME/$USER` ok')
    expect(richMarkdown(`<pre>echo ${S}</pre>`)).toBe('<pre>echo $HOME/$USER</pre>')
  })

  test('URLs keep their $, except bare ones, which Telegram reads as text', () => {
    expect(richMarkdown('<https://example.com/?q=$1>')).toBe('<https://example.com/?q=$1>')
    expect(richMarkdown('[pay $1](https://example.com/?q=$1)')).toBe('[pay \\$1](https://example.com/?q=$1)')
    expect(richMarkdown('see https://example.com/?q=$1 now')).toBe('see https://example.com/?q=\\$1 now')
  })

  test('math and existing escapes stay as written', () => {
    expect(richMarkdown(`<tg-math>x^2</tg-math> costs ${S}`)).toBe('<tg-math>x^2</tg-math> costs \\$HOME/\\$USER')
    expect(richMarkdown('```math\nE = $x$\n```')).toBe('```math\nE = $x$\n```')
    expect(richMarkdown('already \\$5 and \\\\$6')).toBe('already \\$5 and \\\\\\$6')
  })

  test('inside <details> it is Markdown again, code included', () => {
    expect(richMarkdown(`<details><summary>Cost ${S}</summary>\nItem ${S}\n\`\`\`\necho ${S}\n\`\`\`\n</details>`))
      .toBe('<details><summary>Cost \\$HOME/\\$USER</summary>\nItem \\$HOME/\\$USER\n```\necho $HOME/$USER\n```\n</details>')
  })

  test('<details> in any layout: summary on its own line, in a list, around code, with text after', () => {
    const E = '\\$HOME/\\$USER'
    expect(richMarkdown(`<details>\n<summary>Cost ${S}</summary>\nItem ${S}\n</details>`))
      .toBe(`<details>\n<summary>Cost ${E}</summary>\nItem ${E}\n</details>`)
    expect(richMarkdown(`- a\n  - b\n    <details><summary>S</summary>\n    body ${S}\n    </details>`))
      .toBe(`- a\n  - b\n    <details><summary>S</summary>\n    body ${E}\n    </details>`)
    expect(richMarkdown(`<details><summary>x</summary>\n\`\`\`bash\necho $a\n\necho $b\n\`\`\`\n</details>\nafter ${S}`))
      .toBe(`<details><summary>x</summary>\n\`\`\`bash\necho $a\n\necho $b\n\`\`\`\n</details>\nafter ${E}`)
    expect(richMarkdown(`<details><summary>A</summary>\n<details><summary>B ${S}</summary>\nC Vec<String>\n</details>\n</details>`))
      .toBe(`<details><summary>A</summary>\n<details><summary>B ${E}</summary>\nC Vec&lt;String>\n</details>\n</details>`)
    expect(richMarkdown('```html\n<details><summary>$x</summary>\n```')).toBe('```html\n<details><summary>$x</summary>\n```')
    expect(richMarkdown('<pre>\n<details>\n$x\n</pre>')).toBe('<pre>\n<details>\n$x\n</pre>')
  })

  test('a tag that ends its line ends the block, as in Telegram: an indented line after it is code', () => {
    for (const md of [
      '<details><summary>Out</summary>\n    $ ls $HOME/$USER\n</details>',
      '<details>\n    $ ls $HOME/$USER\n</details>',
      '<details><summary>A</summary>\nbody\n</details>\n    $ ls $HOME/$USER',
    ]) expect(richMarkdown(md)).toBe(md)
  })

  test('a tag Telegram would drop becomes text; HTML it renders or drops stays', () => {
    expect(richMarkdown('Vec<String>, Promise<void> and </T>; <kbd>Ctrl</kbd> <b>b</b>'))
      .toBe('Vec&lt;String>, Promise&lt;void> and &lt;/T>; <kbd>Ctrl</kbd> <b>b</b>')
    expect(richMarkdown('`Vec<String>`')).toBe('`Vec<String>`')
  })
})

describe('richParts', () => {
  const small = { bytes: 100, blocks: 400 }

  test('one part when it fits, with the text as written for a plain fallback', () => {
    expect(richParts('costs $5')).toEqual([{ rich: 'costs \\$5', plain: 'costs $5' }])
    expect(richParts('\n\n   ```\n   $x\n   ```\n')).toEqual([{ rich: '   ```\n   $x\n   ```', plain: '   ```\n   $x\n   ```' }])
  })

  test('cuts between top-level blocks, counting UTF-8 bytes', () => {
    const para = 'ж'.repeat(30)
    const parts = richParts([para, para, para].join('\n\n'), small)
    expect(parts.map(p => p.plain)).toEqual([para, para, para])
    for (const p of parts) expect(Buffer.byteLength(p.rich)).toBeLessThanOrEqual(100)
  })

  test('cuts by block count', () => {
    const parts = richParts(['a', 'b', 'c', 'd', 'e'].join('\n\n'), { bytes: 1000, blocks: 2 })
    expect(parts.map(p => p.plain)).toEqual(['a\n\nb', 'c\n\nd', 'e'])
  })

  test('a code block too big alone is closed and reopened around each cut', () => {
    const body = Array.from({ length: 12 }, (_, i) => `echo $${i}`)
    const parts = richParts('intro\n\n```bash\n' + body.join('\n') + '\n```', small)
    expect(parts[0]!.plain).toBe('intro')
    const code = parts.slice(1)
    expect(code.length).toBeGreaterThan(1)
    for (const p of code) {
      expect(p.rich.startsWith('```bash\n')).toBe(true)
      expect(p.rich.endsWith('\n```')).toBe(true)
      expect(p.rich).not.toContain('\\$')
      expect(Buffer.byteLength(p.rich)).toBeLessThanOrEqual(100)
    }
    expect(code.flatMap(p => p.rich.split('\n').slice(1, -1))).toEqual(body)
  })

  test('a table too big alone repeats its header', () => {
    const rows = Array.from({ length: 10 }, (_, i) => `| ${i} | $${i} |`)
    const parts = richParts(['| n | cost |', '|---|---|', ...rows].join('\n'), small)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.plain.startsWith('| n | cost |\n|---|---|\n')).toBe(true)
    expect(parts.flatMap(p => p.plain.split('\n').slice(2))).toEqual(rows)
  })

  test('a <details> inside a list item does not cut the list', () => {
    const list = '- a\n  <details><summary>S</summary>\n  body\n  </details>\n- b'
    expect(richParts(list + '\n\nafter', { bytes: 1000, blocks: 1 }).map(p => p.plain)).toEqual([list, 'after'])
    // Too big for one part, the list is cut between its items, not at the tag.
    expect(richParts(list + '\n\nafter', { bytes: 58, blocks: 400 }).map(p => p.plain))
      .toEqual(['- a\n  <details><summary>S</summary>\n  body\n  </details>', '- b', 'after'])
  })

  test('a <details> in code, raw <pre> or prose opens no section', () => {
    const one = { bytes: 1000, blocks: 1 }
    expect(richParts('<details><summary>Ex</summary>\n```html\n<details>\n```\n</details>\n\na\n\nb', one).map(p => p.plain))
      .toEqual(['<details><summary>Ex</summary>\n```html\n<details>\n```\n</details>', 'a', 'b'])
    expect(richParts('<pre>\n<details>\n</pre>\n\na\n\nb', one).map(p => p.plain)).toEqual(['<pre>\n<details>\n</pre>', 'a', 'b'])
    expect(richParts('Use <details> for a fold.\n\na\n\nb', one).map(p => p.plain)).toEqual(['Use <details> for a fold.', 'a', 'b'])
    expect(richParts('```\n<details>\n```\n\na\n\nb', one).map(p => p.plain)).toEqual(['```\n<details>\n```', 'a', 'b'])
  })

  test('a <details> section is never cut between its tags', () => {
    const md = ['before', '<details><summary>More</summary>', 'one', 'two', '</details>', 'after'].join('\n\n')
    const parts = richParts(md, { bytes: 1000, blocks: 2 })
    expect(parts.map(p => p.plain)).toEqual(['before', '<details><summary>More</summary>\n\none\n\ntwo\n\n</details>', 'after'])
  })

  test('text of Unicode spaces is still sent', () => {
    expect(richParts('\u3000').map(p => p.plain)).toEqual(['\u3000'])
    expect(richParts('a\n\n\u00a0\n\nb').map(p => p.plain)).toEqual(['a\n\n\u00a0\n\nb'])
  })

  test('the parts cover the text once: a bare CR between blocks sends nothing twice', () => {
    const md = 'A'.repeat(60) + '\r\r' + 'B'.repeat(60) + '\r\r' + 'C'.repeat(60)
    expect(richParts(md, small).map(p => p.plain)).toEqual(['A'.repeat(60), 'B'.repeat(60), 'C'.repeat(60)])
  })

  test('a list too big alone is cut between items; an item too big alone goes out plain', () => {
    const items = Array.from({ length: 6 }, (_, i) => `- item ${i} $${i} ${'x'.repeat(20)}`)
    const big = '- big\n  ```\n' + '  line $x\n'.repeat(12) + '  ```'
    const parts = richParts([...items.slice(0, 3), big, ...items.slice(3)].join('\n'), small)
    expect(parts.map(p => p.plain).join('\n')).toBe([...items.slice(0, 3), big, ...items.slice(3)].join('\n'))
    for (const p of parts) {
      if (p.rich === undefined) expect(p.plain).toBe(big)
      else {
        expect(p.rich.startsWith('- item')).toBe(true)
        expect(Buffer.byteLength(p.rich)).toBeLessThanOrEqual(100)
      }
    }
  })

  test('a quote too big alone is cut between its blocks, each part still quoted', () => {
    const blocks = Array.from({ length: 6 }, (_, i) => `> quote ${i} $${i} ${'q'.repeat(20)}`)
    const parts = richParts(blocks.join('\n>\n'), small)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.rich!.startsWith('> quote')).toBe(true)
  })

  test('a code line too long alone is cut inside its fence, never inside a surrogate pair', () => {
    const parts = richParts('```\n' + '😀'.repeat(60) + '\n```', small)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) {
      expect(Buffer.byteLength(p.rich!)).toBeLessThanOrEqual(100)
      expect(p.rich).toMatch(/^```\n\p{Extended_Pictographic}+\n```$/u)
    }
  })

  test('a lone surrogate is counted as the 3 bytes it goes out as', () => {
    for (const p of richParts('```\n' + '\udc00'.repeat(60) + '\n```', small)) expect(Buffer.byteLength(p.rich!)).toBeLessThanOrEqual(100)
  })

  test('an unclosed fence keeps its last line', () => {
    const parts = richParts('```\n' + 'code $x\n'.repeat(20) + '```js', small)
    expect(parts.at(-1)!.plain.endsWith('```js\n```')).toBe(true)
  })

  test('a paragraph too big alone goes out plain, as written', () => {
    const line = 'word $x `c$` '.repeat(20)
    expect(richParts(line, small)).toEqual([{ plain: line.trimEnd() }])
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i} $x \`c\``).join('\n')
    expect(richParts(lines, small)).toEqual([{ plain: lines }])
  })
})

describe('richPartsAsync', () => {
  test('splits in a worker as richParts does', async () => {
    expect(await richPartsAsync('costs $5')).toEqual(richParts('costs $5'))
  })

  test('text the parser has not split in time goes out plain, and the next text splits again', async () => {
    const deep = Array.from({ length: 400 }, (_, i) => ' '.repeat(i * 2) + '- x').join('\n')
    const t = Date.now()
    const [stuck, behind] = await Promise.all([richPartsAsync(deep, undefined, 300), richPartsAsync('queued $x')])
    expect(stuck).toEqual([{ plain: deep }])
    expect(behind).toEqual([{ plain: 'queued $x' }])
    expect(Date.now() - t).toBeLessThan(2000)
    expect(await richPartsAsync('next $x')).toEqual(richParts('next $x'))
  })
})

describe('plainFallback', () => {
  test('content Telegram rejects or a server without rich messages, nothing else', () => {
    expect(plainFallback({ error_code: 400, description: 'Bad Request: RICH_MESSAGE_MARKDOWN_INVALID' })).toBe(true)
    expect(plainFallback({ error_code: 400, description: 'Bad Request: RICH_MESSAGE_BLOCKS_TOO_MANY' })).toBe(true)
    expect(plainFallback({ error_code: 404, description: 'Not Found: method not found' })).toBe(true)
    expect(plainFallback({ error_code: 400, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same' })).toBe(false)
    expect(plainFallback({ error_code: 429, description: 'Too Many Requests: retry after 5' })).toBe(false)
    expect(plainFallback(new Error('Network request failed'))).toBe(false)
  })
})

function fakeRaw(fail: (method: string, n: number) => unknown = () => undefined) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let id = 100
  const run = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    const err = fail(method, calls.filter(c => c.method === method).length)
    if (err) throw err
    return { message_id: ++id }
  }
  const raw: RawApi = {
    sendRichMessage: params => run('sendRichMessage', params),
    sendMessage: params => run('sendMessage', params),
    editMessageText: params => run('editMessageText', params),
  }
  return { raw, calls }
}

const progress = () => ({ ids: [] as number[], done: 0, total: 0 })
const rejected = { error_code: 400, description: 'Bad Request: RICH_MESSAGE_MARKDOWN_INVALID' }

describe('sendRich', () => {
  test('sends escaped Markdown as a rich message, replying on the first message', async () => {
    const f = fakeRaw()
    const p = progress()
    await sendRich({ raw: f.raw, chatId: '42', text: 'costs $5', replyTo: n => (n === 0 ? 7 : undefined), plainChunks: t => [t], progress: p })
    expect(p).toEqual({ ids: [101], done: 1, total: 1 })
    expect(f.calls).toEqual([{
      method: 'sendRichMessage',
      params: {
        chat_id: '42',
        rich_message: { markdown: 'costs \\$5' },
        reply_parameters: { message_id: 7, allow_sending_without_reply: true },
      },
    }])
  })

  test('content Telegram rejects goes out plain, unescaped, cut by plainChunks, each threaded as asked', async () => {
    const f = fakeRaw(m => (m === 'sendRichMessage' ? rejected : undefined))
    const p = progress()
    await sendRich({ raw: f.raw, chatId: '42', text: 'costs $5', replyTo: () => 7, plainChunks: t => [t.slice(0, 4), t.slice(4)], progress: p })
    expect(p.ids).toEqual([101, 102])
    expect(f.calls.map(c => [c.method, c.params.text, c.params.reply_parameters])).toEqual([
      ['sendRichMessage', undefined, { message_id: 7, allow_sending_without_reply: true }],
      ['sendMessage', 'cost', { message_id: 7, allow_sending_without_reply: true }],
      ['sendMessage', 's $5', { message_id: 7, allow_sending_without_reply: true }],
    ])
  })

  test('a part only plain text keeps whole goes out plain without a rich try', async () => {
    const f = fakeRaw()
    const p = progress()
    const text = 'word $x '.repeat(5000)
    await sendRich({ raw: f.raw, chatId: '42', text, replyTo: () => undefined, plainChunks: t => [t.slice(0, 4096), t.slice(4096)], progress: p })
    expect(f.calls.map(c => c.method)).toEqual(['sendMessage', 'sendMessage'])
    expect(p).toEqual({ ids: [101, 102], done: 1, total: 1 })
  })

  test('a failure part way leaves what was sent in progress and rethrows', async () => {
    const tooMany = { error_code: 429, description: 'Too Many Requests: retry after 5' }
    const f = fakeRaw((m, n) => (m === 'sendRichMessage' && n === 2 ? tooMany : undefined))
    const p = progress()
    const text = 'a'.repeat(20_000) + '\n\n' + 'b'.repeat(20_000)
    await expect(sendRich({ raw: f.raw, chatId: '42', text, replyTo: () => undefined, plainChunks: t => [t], progress: p })).rejects.toBe(tooMany)
    expect(p).toEqual({ ids: [101], done: 1, total: 2 })
    expect(f.calls.map(c => c.method)).toEqual(['sendRichMessage', 'sendRichMessage'])
  })

  test('each message sent is reported with the text Claude wrote for it: the part as written, or each plain chunk', async () => {
    const rich = fakeRaw()
    const seen: [number, string][] = []
    await sendRich({ raw: rich.raw, chatId: '7', text: 'costs $5', replyTo: () => undefined, plainChunks: t => [t], progress: progress(), sent: (id, t) => seen.push([id, t]) })
    expect(seen).toEqual([[101, 'costs $5']])

    const plain = fakeRaw(m => (m === 'sendRichMessage' ? rejected : undefined))
    seen.length = 0
    await sendRich({ raw: plain.raw, chatId: '7', text: 'costs $5', replyTo: () => undefined, plainChunks: t => [t.slice(0, 4), t.slice(4)], progress: progress(), sent: (id, t) => seen.push([id, t]) })
    expect(seen).toEqual([[101, 'cost'], [102, 's $5']])
  })
})

describe('editRich', () => {
  test('edits into rich text, or into plain, whole, when Telegram rejects it', async () => {
    const ok = fakeRaw()
    await editRich({ raw: ok.raw, chatId: '42', messageId: 9, text: '$1' })
    expect(ok.calls[0]!.params).toEqual({ chat_id: '42', message_id: 9, rich_message: { markdown: '\\$1' } })

    const long = 'x'.repeat(5000)
    const bad = fakeRaw(m => (m === 'editMessageText' && bad.calls.length === 1 ? rejected : undefined))
    await editRich({ raw: bad.raw, chatId: '42', messageId: 9, text: long })
    expect(bad.calls[1]!.params).toEqual({ chat_id: '42', message_id: 9, text: long })
  })

  test('an unchanged message stays rich: the error goes back, no plain edit', async () => {
    const same = { error_code: 400, description: 'Bad Request: message is not modified' }
    const f = fakeRaw(() => same)
    await expect(editRich({ raw: f.raw, chatId: '42', messageId: 9, text: 'x' })).rejects.toBe(same)
    expect(f.calls.length).toBe(1)
  })

  test('many short blocks still edit as one rich message', async () => {
    const f = fakeRaw()
    await editRich({ raw: f.raw, chatId: '42', messageId: 9, text: Array.from({ length: 450 }, (_, i) => `p${i}`).join('\n\n') })
    expect(f.calls.map(c => Object.keys(c.params))).toEqual([['chat_id', 'message_id', 'rich_message']])
  })

  test('text for more than one rich message is refused before any call', async () => {
    const f = fakeRaw()
    await expect(editRich({ raw: f.raw, chatId: '42', messageId: 9, text: 'a'.repeat(20_000) + '\n\n' + 'b'.repeat(20_000) })).rejects.toThrow('too long')
    expect(f.calls).toEqual([])
  })
})

// The block tree GFM reads: types and leaf text, no positions, no spread.
const tree = (md: string): unknown => {
  const shape = (n: any): unknown =>
    'value' in n ? [n.type, n.value] : [n.type, ...(n.children ?? []).map(shape)]
  return shape(fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }))
}

const q = (n: number) => '> '.repeat(n)
const cols = (n: number, cell = ' c |') => '|' + cell.repeat(n)
const delim = (n: number) => '|' + '---|'.repeat(n)

// [text, the line inserted] for each shape the rule fires on.
const FIRES: [string, string][] = [
  ['**The real risks**\n| Risk | Impact |\n|---|---|\n| a | b |', '\n'],
  ['> para\n> | a | b |\n> |---|---|', '\n>'],
  ['> > para\n> > | a | b |\n> > |---|---|', '\n> >'],
  ['> > > para\n> > > | a | b |\n> > > |---|---|', '\n> > >'],
  ['- a\n  | x | y |\n  |---|---|\n  | 1 | 2 |\n- b\n- c', '\n'],
  ['* a\n  | x | y |\n  |---|---|', '\n'],
  ['+ a\n  | x | y |\n  |---|---|', '\n'],
  ['1. a\n   | x | y |\n   |---|---|', '\n'],
  ['1) a\n   | x | y |\n   |---|---|', '\n'],
  ['- [ ] a\n  | x | y |\n  |---|---|', '\n'],
  ['- a\n  - b\n    | x | y |\n    |---|---|', '\n'],
  ['> - a\n>   | x | y |\n>   |---|---|', '\n>'],
  ['- > a\n  > | x | y |\n  > |---|---|', '\n  >'],
  ['line one\nline two\n| a | b |\n|---|---|', '\n'],
  ['> para\nlazy\n> | a | b |\n> |---|---|', '\n>'],
  ['para\n | a | b |\n |---|---|', '\n'],
  ['para\n   | a | b |\n   |---|---|', '\n'],
  ['para\na | b\n--|--', '\n'],
  ['para\n1234567890. a | b\n--|--', '\n'],
  ['para\n**Risk** | Impact\n--|--', '\n'],
  ['para\n*a* | b\n--|--', '\n'],
  ['para\n-x | y\n--|--', '\n'],
  ['para\n+1 | y\n--|--', '\n'],
  ['para\n3.5 | x\n--|--', '\n'],
  ['para\n. a | b\n--|--', '\n'],
  ['para\n) a | b\n--|--', '\n'],
  ['para\n3)x | y\n--|--', '\n'],
  ['para\n*\u00a0a | b\n--|--', '\n'],
  ['para\n| a | b |\n|:--|--:|', '\n'],
  ['para  \n| a | b |\n|---|---|', '\n'],
  ['para\t\n| a | b |\n|---|---|', '\n'],
  ['Intro\r\n| Risk | Impact |\r\n|---|---|\r\n| a | b |', '\r\n'],
  ['Intro\r\n| Risk | Impact |\n|---|---|\n| a | b |', '\r\n'],
  ['> para\r\n> | a | b |\r\n> |---|---|', '\r\n>'],
  ['- a\r\n  | x | y |\r\n  |---|---|', '\r\n'],
  ['para\n| a | b |\n|---|---|\r\n', '\n'],
  ['>para\n>| a | b |\n>|---|---|', '\n>'],
  ['>\tpara\n>\t| a | b |\n>\t|---|---|', '\n>'],
  ['- a\n\t| x | y |\n\t|---|---|', '\n'],
  // Telegram's limits: 20 columns, 16 levels (12 quotes, the table, its row, its cell and an entity in its text).
  ['para\n' + cols(20) + '\n' + delim(20), '\n'],
  [q(12) + 'para\n' + q(12) + '| a | b |\n' + q(12) + '|---|---|', '\n' + q(12).trimEnd()],
  [q(12) + 'para\n' + q(12) + '| @someone | b |\n' + q(12) + '|---|---|', '\n' + q(12).trimEnd()],
  [q(11) + 'para\n' + q(11) + '| **a** | b |\n' + q(11) + '|---|---|', '\n' + q(11).trimEnd()],
  [q(10) + 'para\n' + q(10) + '| <b>a</b> | b |\n' + q(10) + '|---|---|', '\n' + q(10).trimEnd()],
  [q(10) + 'para\n' + q(10) + '| ==a== | b |\n' + q(10) + '|---|---|', '\n' + q(10).trimEnd()],
  [q(10) + 'para\n' + q(10) + '| \\|\\|a\\|\\| | b |\n' + q(10) + '|---|---|', '\n' + q(10).trimEnd()],
  [q(11) + 'para\n' + q(11) + '| a[^1] | b |\n' + q(11) + '|---|---|\n\n[^1]: note', '\n' + q(11).trimEnd()],
  // Raw HTML and pairs closed where they open, a tag that closes nothing, and no element open around the paragraph.
  ['para <b>x</b> ==y==\n| a | b |\n|---|---|', '\n'],
  ['<p>x</p>\n\npara\n| a | b |\n|---|---|', '\n'],
  ['<hr>\n\npara\n| a | b |\n|---|---|', '\n'],
  ['<tg-map lat="1" long="2"/>\n\npara\n| a | b |\n|---|---|', '\n'],
  ['para\n| <b>a</b><br>==m== | b |\n|---|---|', '\n'],
  // A comment opens no element; a pair closed across formatting in the paragraph and in a cell.
  ['<!-- note -->\n\npara\n| a | b |\n|---|---|', '\n'],
  ['para ==a **b** c==\n| ==x *y* z== | b |\n|---|---|', '\n'],
  // Each cell's count even, though main's text pairs a mark across the pipe (sent live: main highlights `z | w`).
  ['Intro\n| a | b |\n|---|---|\n| x == y ==z | w== v == u |', '\n'],
]

const SAME: string[] = [
  '# H\n| a | b |\n|---|---|',
  '```\nx\n```\n| a | b |\n|---|---|',
  '| a | b |\n|---|---|',
  '- | a | b |\n  |---|---|',
  '[^1]: note\n    | a | b |\n    |---|---|\n\nText[^1]',
  '[^1]: note\n    > q\n    > | a | b |\n    > |---|---|\n\nText[^1]',
  '[^1]: note\n    - q\n      | a | b |\n      |---|---|\n\nText[^1]',
  'para\r| a | b |\r|---|---|',
  '> para\n| a | b |\n> |---|---|',
  '- a\n| x | y |\n  |---|---|',
  '1. a\n  | x | y |\n   |---|---|',
  '> > para\n> | a | b |\n> > |---|---|',
  '> - a\n| x | y |\n>   |---|---|',
  '> para\na | b\n> --|--',
  'para\n  | a | b |\n|---|---|',
  '> para\n>| a | b |\n> |---|---|',
  '- p\n\n  # H\n  | a | b |\n  |---|---|',
  'para\n- a', 'para\n> q', 'para\n# H', 'para\n```\nx\n```', 'para\n***', 'para\n<div>x</div>',
  'para\n```\n| a | b |\n|---|---|\n```',
  'para\n<div>\n| a | b |\n|---|---|\n</div>',
  'para\n\n| a | b |\n|---|---|',
  '| a | b |\n|---|---|\nafter',
  'para\n    | a | b |\n    |---|---|',
  '- a\n  - b',
  '[^1]: note\n    | a | b |\r    |---|---|\n\nText[^1]',
  // A lone CR in the paragraph, the table or the end of its last line.
  '> para\n> | a | b |\r> |---|---|',
  'para\n| a | b |\r|---|---|',
  'para\n| a | b |\r|---|---|\r| 1 | 2 |',
  'para\r\n| a | b |\r|---|---|',
  '- a\n  | x | y |\r  |---|---|',
  '- a\n  | x | y |\r  |---|---|\n- b',
  '> > para\n> > | a | b |\r> > |---|---|',
  '> - a\n>   | x | y |\r>   |---|---|',
  '- > a\n  > | x | y |\r  > |---|---|',
  'para\n| a | b |\n|---|---|\r| 1 | 2 |',
  'line one\rline two\n| a | b |\n|---|---|',
  'para\n| a | b |\n|---|---|\r',
  'para\n| a | b |\r\r|---|---|',
  '> para\n| a | b |\r> |---|---|\nafter',
  '- a\n| x | y |\r  |---|---|\nafter',
  '> para\n| a | b |\r> |---|---|',
  '- a\n| x | y |\r  |---|---|',
  '> > para\n> | a | b |\r> > |---|---|',
  'para\n  | a | b |\r|---|---|',
  '> para\n> | a | b |\r>|---|---|',
  // Over Telegram's limits: 21 columns in the head or a body row, 17 levels.
  'para\n' + cols(21) + '\n' + delim(21),
  'para\n' + cols(20) + '\n' + delim(20) + '\n' + cols(21, ' 1 |'),
  q(13) + 'para\n' + q(13) + '| a | b |\n' + q(13) + '|---|---|',
  q(13) + 'para\n' + q(13) + '| @someone | b |\n' + q(13) + '|---|---|',
  q(12) + 'para\n' + q(12) + '| **a** | b |\n' + q(12) + '|---|---|',
  q(11) + 'para\n' + q(11) + '| <b>a</b> | b |\n' + q(11) + '|---|---|',
  q(11) + 'para\n' + q(11) + '| ==a== | b |\n' + q(11) + '|---|---|',
  q(11) + 'para\n' + q(11) + '| \\|\\|a\\|\\| | b |\n' + q(11) + '|---|---|',
  q(12) + 'para\n' + q(12) + '| a[^1] | b |\n' + q(12) + '|---|---|\n\n[^1]: note',
  // A cell holds text only: an image or an HTML tag Telegram makes a block from.
  'para\n| ![x](https://example.com/p.jpg) | b |\n|---|---|',
  'para\n| ![x][p] | b |\n|---|---|\n\n[p]: https://example.com/p.jpg',
  'para\n| <img src="https://example.com/p.jpg"> | b |\n|---|---|',
  'para\n| a <blockquote>q</blockquote> | b |\n|---|---|',
  // <details> other than as sent live.
  '- x\n  <details><summary>S</summary>\n  Text\n  | a | b |\n  |---|---|\n  </details>',
  '> <details><summary>S</summary>\n> Text\n> | a | b |\n> |---|---|\n> </details>',
  '<details><summary>S</summary>\n> Text\n> | a | b |\n> |---|---|\n</details>',
  '<details><summary>S</summary>Text\n| a | b |\n|---|---|\n</details>',
  '<details><summary>S</summary>\nText\n| a | b |\n|---|---|\nNote <details><summary>B</summary>',
  '<details><summary>S</summary>\nText\n| a | b |\n|---|---|\n\nNote <summary>B</summary> more\n</details>',
  '<details><summary>S</summary>\nText\n| a | b |\n|---|---|',
  '<details><summary>A</summary>\n<details><summary>B</summary>\nText\n| a | b |\n|---|---|\n</details>\n</details>',
  '<details><summary>S</summary>\nText\n| a | b |\n|---|---|\n\n<details><summary>B</summary>\nx\n</details>\n</details>',
  ' <details><summary>S</summary>\nText\n| a | b |\n|---|---|\n</details>',
  '<details><summary>S</summary>\nText\n| a | b |\n|---|---|\n\n </details>',
  'Text\n| a | <details> |\n|---|---|',
  'Text <summary>x</summary>\n| a | b |\n|---|---|',
  '<details><summary>S</summary>\nText\n| a | ' + '<b>'.repeat(6) + 'x' + '</b>'.repeat(6) + ' |\n|---|---|\n</details>',
  // Raw HTML open around the paragraph: a collage, a slideshow, a quote, a dropped tag, a summary outside a section, an earlier tag.
  '<tg-collage>\n\npara\n| a | b |\n|---|---|\n\n</tg-collage>',
  '<tg-slideshow>\n\npara\n| a | b |\n|---|---|\n\n</tg-slideshow>',
  '<blockquote>\n\npara\n| a | b |\n|---|---|\n\n</blockquote>',
  '<div>\n\npara\n| a | b |\n|---|---|\n\n</div>',
  '<summary>\n\npara\n| a | b |\n|---|---|\n\n</summary>',
  'Intro <span>x\n\npara\n| a | b |\n|---|---|',
  // A tag, a == or a || the line would split from its pair, across the paragraph and the table or across cells.
  '<b>para\n| a | b |\n|---|---|\n| c | d</b> |',
  '<tg-spoiler>para\n| a | b |\n|---|---|\n| c | d</tg-spoiler> |',
  '==para\n| a | b |\n|---|---|\n| x== | y |',
  '||para\n| a | b |\n|---|---|',
  'para\n| <b>a | b</b> |\n|---|---|',
  'para\n| ==a | b== |\n|---|---|',
  'para\n| \\|\\|a | b\\|\\| |\n|---|---|',
  'para\n| a || b |\n|---|---|---|',
  // A cell holding a tag the page builds no text from.
  'para\n| <tr> | b |\n|---|---|',
  'para\n| <a name="x"></a>a | b |\n|---|---|',
  'para\n| <a href="https://t.me">a</a> | b |\n|---|---|',
  'para\n| <kbd>a</kbd> | b |\n|---|---|',
  'para\n| <tg-map lat="1" long="2"/> | b |\n|---|---|',
  // A == read one way and not another: an escape or a reference beside a mark, an escape that joins two =, four in a row.
  'para \\=\\= x ==\n| a | b |\n|---|---|\n| \\=\\= c == | d |',
  'para\n| a | b |\n|---|---|\n| \\=\\= c == | \\=\\= d == |',
  'para\n| a | b |\n|---|---|\n| &#61;= c == | &#61;= d == |',
  'para a \\== b ==\n| a | b |\n|---|---|',
  'para \\=\\= x \\==\n| a | b |\n|---|---|',
  'para \\\\== b \\==\n| a | b |\n|---|---|',
  'para ==== x\n| a | b |\n|---|---|',
  'para\n| a ==== b | c |\n|---|---|',
  // A tag inside a comment counts as left open; a closing tag inside a <pre> closes nothing; a cell holding a comment.
  '<!-- <b> -->\n\npara\n| a | b |\n|---|---|',
  'Intro <span>x\n\n<!-- </span> -->\n\npara\n| a | b |\n|---|---|',
  'Intro <span>x\n\n<!-- a > b </span> -->\n\npara\n| a | b |\n|---|---|',
  '<tg-collage>\n\n<!-- </tg-collage> -->\n\npara\n| a | b |\n|---|---|\n\n</tg-collage>',
  'Intro <span>x\n\n<pre>\n</span>\n</pre>\n\npara\n| a | b |\n|---|---|',
  'para\n| <!-- c --> a | b |\n|---|---|',
  // A head row with no leading pipe that starts with a list marker that cannot interrupt a paragraph
  // (an ordered one not numbered 1, or an empty item): the blank line would open a list.
  'Steps\n3. Deploy | Owner\n---|---\n| x | y |',
  'para\n2) a | b\n--|--\n| 1 | 2 |',
  'para\n10) Step | Detail\n---|---',
  'para\n0) a | b\n--|--',
  '> para\n> 3) x | y\n> --|--',
  '> para\n> 2. x | y\n> --|--',
  '- a\n  2) x | y\n  --|--',
  '- a\n  3. x | y\n  --|--',
  'para\n2.\ta | b\n--|--',
  'para\n123. a | b\n--|--',
  'para\n123456789. a | b\n--|--',
  'para\n*\n|---|',
  'para\n+\n|---|',
  'para\n1.\n|---|',
  'para\n2.\n|---|',
  '> para\n> *\n> |---|',
  '- a\n  1.\n  |---|',
]

describe('a table right under a paragraph', () => {
  test('corpus: one inserted line where it fires, byte-identical elsewhere, the GFM tree kept', () => {
    for (const [md, line] of FIRES) {
      const out = richMarkdown(md)
      let i = 0
      while (i < md.length && out[i] === md[i]) i++
      expect([md, out.slice(i, i + line.length), out.slice(i + line.length)]).toEqual([md, line, md.slice(i)])
      expect([md, tree(out)]).toEqual([md, tree(md)])
    }
    for (const md of SAME) expect([md, richMarkdown(md)]).toEqual([md, md])
    // Head rows near a list marker, generated, at the top level: bare and with cells, after an LF, and bare after a CRLF.
    // A table to the parser gains its line exactly when a blank line above it keeps the tree, and is as written otherwise.
    const parse = (s: string) => fromMarkdown(s, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
    const shape = (n: any): unknown => 'value' in n ? [n.type, n.value] : [n.type, ...(n.children ?? []).map(shape)]
    const ascii = Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).filter(c => c !== '$') // a $ gains its escape, held by its own test
    const spaces = Array.from({ length: 0x10000 }, (_, i) => String.fromCharCode(i)).filter(c => /\s/.test(c) && c !== '\n' && c !== '\r')
    const numbers = [...Array.from({ length: 10 }, (_, i) => String(i)), '00', '01', '09', '007', '10', '99', '1'.repeat(9), '9'.repeat(9), '0'.repeat(8) + '5', '1'.repeat(10), '9'.repeat(10), 'a', 'Note', '(1', 'x1']
    const markers = ['*', '+', '-', '1.', '1)', '3.', '3)']
    // Each part the check reads, swept on its own: the first character, the number, the character after it, and what follows the marker.
    const heads: string[] = [...ascii, '\u2022', '\u2023', '\u25e6', '\u00b7', '\u2013', '\u2014', '**', '--', '++']
    for (const n of numbers) for (const m of ['.', ')', '']) heads.push(n + m)
    for (const m of ascii) heads.push('3' + m)
    for (const h of markers) for (const t of [...spaces, 'x']) heads.push(h + t)
    const forms: string[][] = heads.flatMap(h => [[h + ' ', 'a | b', '--|--', '\n'], [h, '', '|---|', '\n']])
    for (const h of markers) forms.push([h, '', '|---|', '\r\n'])
    let swept = 0
    for (const [head, row, sep, nl] of forms) {
      const md = `para${nl}${head}${row}${nl}${sep}`
      const p = parse(md)
      if (p.children.map(c => c.type).join(',') !== 'paragraph,table') continue
      swept++
      const gained = `para${nl}${nl}${head}${row}${nl}${sep}`
      const want = JSON.stringify(shape(parse(gained))) === JSON.stringify(shape(p)) ? gained : md
      expect([md, richMarkdown(md)]).toEqual([md, want])
    }
    expect(swept).toBeGreaterThan(800)
  })

  test('fires: exact output', () => {
    expect(richMarkdown('**The real risks**\n| Risk | Impact |\n|---|---|\n| a | b |'))
      .toBe('**The real risks**\n\n| Risk | Impact |\n|---|---|\n| a | b |')
    expect(richMarkdown('- a\n  | x | y |\n  |---|---|')).toBe('- a\n\n  | x | y |\n  |---|---|')
    expect(richMarkdown('Intro\r\n| a | b |\r\n|---|---|')).toBe('Intro\r\n\r\n| a | b |\r\n|---|---|')
    expect(richMarkdown('> para\r\n> | a | b |\r\n> |---|---|')).toBe('> para\r\n>\r\n> | a | b |\r\n> |---|---|')
    expect(richMarkdown('para  \n| a | b |\n|---|---|')).toBe('para  \n\n| a | b |\n|---|---|')
    expect(richMarkdown('> > para\n> > | a | b |\n> > |---|---|')).toBe('> > para\n> >\n> > | a | b |\n> > |---|---|')
    // A name sent as &lt; is text to Telegram, no tag.
    expect(richMarkdown('Vec<String>\n| a | b |\n|---|---|')).toBe('Vec&lt;String>\n\n| a | b |\n|---|---|')
  })

  test('details: a table under text inside a top-level <details> gets the line, as sent live', () => {
    expect(richMarkdown('<details><summary>S</summary>\nText\n| a | b |\n|---|---|\n| 1 | 2 |\n</details>'))
      .toBe('<details><summary>S</summary>\nText\n\n| a | b |\n|---|---|\n| 1 | 2 |\n</details>')
    expect(richMarkdown('Before\n\n<details><summary>S</summary>\nText\n| a | b |\n|---|---|\n\nMore\n</details>\n\nAfter'))
      .toBe('Before\n\n<details><summary>S</summary>\nText\n\n| a | b |\n|---|---|\n\nMore\n</details>\n\nAfter')
    // 16 levels: the section, the table, its row, its cell, an entity in its text and 11 tags in the cell.
    const at16 = '<details><summary>S</summary>\nText\n| a | ' + '<b>'.repeat(5) + 'x' + '</b>'.repeat(5) + '<br> |\n|---|---|\n</details>'
    expect(richMarkdown(at16)).toBe(at16.replace('Text\n', 'Text\n\n'))
  })

  test('details arrangements: no <summary>, <details open> and a <summary> on its own line get the line, as sent live', () => {
    const table = '| a | b |\n|---|---|\n| 1 | 2 |\n</details>'
    for (const head of ['<details>\n\n', '<details>\n', '<details open><summary>S</summary>\n', '<details>\n<summary>S</summary>\n',
      '<details>\n<summary>S</summary>\n\n', '<details open>\n<summary>S</summary>\n', '<details open>\n<summary>S</summary>\n\n'])
      expect([head, richMarkdown(head + 'Text\n' + table)]).toEqual([head, head + 'Text\n\n' + table])
  })

  test('time: a long HTML block whose < meet no > is read in time linear in its length', () => {
    const md = '<p>x</p>\n' + 'x<y '.repeat(50_000) + '\n\npara\n| a | b |\n|---|---|'
    const start = performance.now()
    const parts = richParts(md)
    expect(performance.now() - start).toBeLessThan(3000)
    expect(parts.map(p => p.rich)).toEqual([undefined, 'para\n\n| a | b |\n|---|---|'])
  })

  test('dollar: a $ that opens the table keeps its escape and the blank line', () => {
    expect(richMarkdown('para\n$a | b\n--|--')).toBe('para\n\n\\$a | b\n--|--')
  })

  test('a cut between a paragraph and its table adds no line to either part', () => {
    const md = 'p'.repeat(40) + '\n| a | b |\n|---|---|\n| 1 | 2 |'
    expect(richParts(md, { bytes: 45, blocks: 400 })).toEqual([
      { rich: 'p'.repeat(40), plain: 'p'.repeat(40) },
      { rich: '| a | b |\n|---|---|\n| 1 | 2 |', plain: '| a | b |\n|---|---|\n| 1 | 2 |' },
    ])
  })

  const top = 'p'.repeat(40) + '\n| a | b |\n|---|---|\n| 1 | 2 |'
  const quote = '> ' + 'q'.repeat(40) + '\n> | a | b |\n> |---|---|\n> | 1 | 2 |'
  const items = '- ' + 'l'.repeat(40) + '\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n- b\n- c'
  const item = '- ' + 'l'.repeat(40) + '\n  | a | b |\n  |---|---|\n  | 1 | 2 |'
  const deep = '> > ' + 'q'.repeat(40) + '\n> > | a | b |\n> > |---|---|\n> > | 1 | 2 |'
  const det = '<details><summary>S</summary>\n' + 'd'.repeat(30) + '\n| a | b |\n|---|---|\n| 1 | 2 |\n</details>'
  // Each text with the bytes its line adds.
  const AT: [string, number][] = [[top, 1], [quote, 2], [items, 1], [item, 1], [deep, 4], [det, 1]]
  const lim = (bytes: number) => ({ bytes, blocks: 400 })
  const raw = (calls: Record<string, unknown>[]): RawApi => ({
    sendRichMessage: async () => ({ message_id: 1 }),
    sendMessage: async () => ({ message_id: 1 }),
    editMessageText: async p => { calls.push(p); return true },
  })

  test('limit kept: a text that fits only without its line is one rich part as written; with room for the line, one part with it', () => {
    for (const [md, add] of AT) {
      expect([md, richParts(md, lim(md.length))]).toEqual([md, [{ rich: md, plain: md }]])
      const fixed = richMarkdown(md)
      expect([md, Buffer.byteLength(fixed)]).toEqual([md, md.length + add])
      expect([md, richParts(md, lim(md.length + add))]).toEqual([md, [{ rich: fixed, plain: md }]])
    }
  })

  test('limit cut: in a longer reply the cuts fall where main puts them, and only the part with room gets its line', () => {
    const md = top + '\n\nafter'
    expect(richParts(md, lim(top.length))).toEqual([{ rich: top, plain: top }, { rich: 'after', plain: 'after' }])
    expect(richParts(md, lim(top.length + 1))).toEqual([{ rich: richMarkdown(top), plain: top }, { rich: 'after', plain: 'after' }])
  })

  test('limit list: a list cut between its items keeps main\'s cut, and its first item gets its line only with room for it', () => {
    const first = items.slice(0, items.indexOf('\n- b'))
    expect(richParts(items, lim(first.length))).toEqual([{ rich: first, plain: first }, { rich: '- b\n- c', plain: '- b\n- c' }])
    expect(richParts(items, lim(first.length + 1))).toEqual([{ rich: richMarkdown(first), plain: first }, { rich: '- b\n- c', plain: '- b\n- c' }])
    // The item with the table last, so it is the list's last part.
    const tail = '- b\n' + item
    expect(richParts(tail, lim(item.length))).toEqual([{ rich: '- b', plain: '- b' }, { rich: item, plain: item }])
    expect(richParts(tail, lim(item.length + 1))).toEqual([{ rich: '- b', plain: '- b' }, { rich: richMarkdown(item), plain: item }])
  })

  test('limit edit: at 30,000 bytes an edit is one rich edit as written; a byte under, it carries the line', async () => {
    for (const md of [top, item]) {
      const pad = (n: number) => md.startsWith('- ') ? md.replace('- ', '- ' + 'l'.repeat(n - md.length)) : 'p'.repeat(n - md.length) + md
      const full = pad(30_000), room = pad(29_999)
      expect(Buffer.byteLength(full)).toBe(30_000)
      expect(await richEditParse(full)).toBe(full)
      const calls: Record<string, unknown>[] = []
      await editRich({ raw: raw(calls), chatId: '1', messageId: 7, text: full })
      await editRich({ raw: raw(calls), chatId: '1', messageId: 7, text: room })
      expect(calls).toEqual([
        { chat_id: '1', message_id: 7, rich_message: { markdown: full } },
        { chat_id: '1', message_id: 7, rich_message: { markdown: richMarkdown(room) } },
      ])
      expect(richMarkdown(room)).not.toBe(room)
    }
  })

  // n one-word paragraphs, each a block.
  const words = (n: number) => 'w\n\n'.repeat(n)
  const pair = 'para\n| a | b |\n|---|---|'

  test('blocks edit: an edit of 400 blocks, counted as Telegram counts them, carries the line; of 401, it is one rich edit as written', async () => {
    // n paragraphs, then the paragraph, the table and its row: n + 3 blocks.
    const calls: Record<string, unknown>[] = []
    await editRich({ raw: raw(calls), chatId: '1', messageId: 7, text: words(397) + pair })
    await editRich({ raw: raw(calls), chatId: '1', messageId: 7, text: words(398) + pair })
    expect(calls).toEqual([
      { chat_id: '1', message_id: 7, rich_message: { markdown: words(397) + 'para\n\n| a | b |\n|---|---|' } },
      { chat_id: '1', message_id: 7, rich_message: { markdown: words(398) + pair } },
    ])
    expect(await richEditParse(words(398) + pair)).toBe(words(398) + pair)
  })

  test('blocks edit over the budget: an edit of 600 top-level blocks is still one rich edit, as main sends it', async () => {
    const calls: Record<string, unknown>[] = []
    await editRich({ raw: raw(calls), chatId: '1', messageId: 7, text: words(600) + pair })
    expect(calls).toEqual([{ chat_id: '1', message_id: 7, rich_message: { markdown: words(600) + pair } }])
  })

  test('blocks nested: list items, their paragraphs and table rows count, though the list is one top-level block', () => {
    // n paragraphs, a list (1) of 101 items (101), their paragraphs (101), the table (1) and its row (1): n + 205.
    const list = (n: number) => words(n) + '- a\n  | x | y |\n  |---|---|\n' + '- b\n'.repeat(100)
    for (const [n, line] of [[195, true], [196, false]] as const) {
      const md = list(n), sent = md.trimEnd()
      const parts = richParts(md)
      expect([n, parts.length]).toEqual([n, 1])
      expect([n, parts[0]!.rich]).toEqual([n, line ? sent.replace('- a\n', '- a\n\n') : sent])
    }
    // A table's rows: n paragraphs, the paragraph, the table, its head row and 10 rows: n + 13.
    const rows = (n: number) => words(n) + pair + '\n| 1 | 2 |'.repeat(10)
    expect(richParts(rows(387))[0]!.rich).toBe(richMarkdown(rows(387)))
    expect(richParts(rows(388))[0]!.rich).toBe(rows(388))
  })

  test('blocks details: one <details> section over 400 blocks is one part as written; at 400, it carries its line', () => {
    // The section (1), the summary line's paragraph (1), n paragraphs, the paragraph, the table and its row: n + 5.
    const sec = (n: number) => '<details><summary>S</summary>\n' + words(n) + 'Text\n| a | b |\n|---|---|\n</details>'
    expect(richParts(sec(395))).toEqual([{ rich: sec(395).replace('Text\n', 'Text\n\n'), plain: sec(395) }])
    expect(richParts(sec(396))).toEqual([{ rich: sec(396), plain: sec(396) }])
  })

  test('blocks html: raw HTML counts two blocks per tag', () => {
    // The paragraph, the table and its row (3), <div>x</div> (4) and n paragraphs: n + 7.
    const md = (n: number) => pair + '\n\n<div>x</div>\n\n' + words(n).trimEnd()
    expect(richParts(md(393))[0]!.rich).toBe(richMarkdown(md(393)))
    expect(richParts(md(394))[0]!.rich).toBe(md(394))
  })

  test('blocks image: a Markdown image counts two blocks, inside raw HTML too', () => {
    // The pair (3), the image's paragraph (1) and the image (2), and n paragraphs: n + 6.
    const md = (n: number) => pair + '\n\n![](https://example.com/p.jpg)\n\n' + words(n).trimEnd()
    expect(richParts(md(394))[0]!.rich).toBe(richMarkdown(md(394)))
    expect(richParts(md(395))[0]!.rich).toBe(md(395))
    // The pair (3), a collage's two tags and two images, two each (8), and n paragraphs: n + 11.
    const col = (n: number) => pair + '\n\n<tg-collage>\n![](https://example.com/a.jpg)\n![](https://example.com/b.jpg)\n</tg-collage>\n\n' + words(n).trimEnd()
    expect(richParts(col(389))[0]!.rich).toBe(richMarkdown(col(389)))
    expect(richParts(col(390))[0]!.rich).toBe(col(390))
  })

  test('blocks cut: a list piece after a cut counts its list again', () => {
    // The first item fills a part; the second piece holds k items (2 each) and the item
    // with the table (4), and its list opens again: 2k + 5.
    const md = (k: number) => '- ' + 'x'.repeat(996) + '\n' + '- w\n'.repeat(k) + '- a\n  | x | y |\n  |---|---|'
    for (const [k, line] of [[197, true], [198, false]] as const) {
      const parts = richParts(md(k), { bytes: 1000, blocks: 400 })
      expect([k, parts.length, parts[0]!.plain.length]).toEqual([k, 2, 998])
      const second = parts[1]!.plain
      expect([k, parts[1]!.rich]).toEqual([k, line ? second.replace('- a\n', '- a\n\n') : second])
      // The same piece in the middle, a third item filling a part after it.
      const three = richParts(md(k) + '\n- ' + 'y'.repeat(996), { bytes: 1000, blocks: 400 })
      expect([k, three.length, three[1]!.plain]).toEqual([k, 3, second])
      expect([k, three[1]!.rich]).toEqual([k, line ? second.replace('- a\n', '- a\n\n') : second])
    }
  })

  test('editRich carries the blank line', async () => {
    const calls: Record<string, unknown>[] = []
    await editRich({ raw: raw(calls), chatId: '1', messageId: 7, text: 'para\n| a | b |\n|---|---|' })
    expect(calls).toEqual([{ chat_id: '1', message_id: 7, rich_message: { markdown: 'para\n\n| a | b |\n|---|---|' } }])
  })
})
