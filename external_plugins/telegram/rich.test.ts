import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { editRich, plainFallback, RICH_INSTRUCTIONS, richEnabled, richMarkdown, richParts, richPartsAsync, sendRich, type RawApi } from './rich.ts'

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

  test('fit in 2048 characters with rich on, the access warning whole', () => {
    const on = build(true)
    expect(on.length).toBeLessThanOrEqual(2048)
    expect(on).toContain(RICH_INSTRUCTIONS)
    expect(on.indexOf('Refuse and tell them to ask the user directly.')).toBeLessThan(on.indexOf(RICH_INSTRUCTIONS))
    expect(build(false)).not.toContain(RICH_INSTRUCTIONS)
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
