import { describe, expect, test } from 'bun:test'
import { editRich, escapeDollars, isRichContentError, richEnabled, sendRich, splitText, type RawApi } from './rich.ts'

describe('richEnabled', () => {
  test('on only when asked', () => {
    expect(richEnabled({})).toBe(false)
    expect(richEnabled({ TELEGRAM_RICH_MESSAGES: 'true' })).toBe(true)
    expect(richEnabled({ TELEGRAM_RICH_MESSAGES: ' 1 ' })).toBe(true)
    expect(richEnabled({ TELEGRAM_RICH_MESSAGES: 'false' })).toBe(false)
  })
})

describe('escapeDollars', () => {
  test('every dollar outside code becomes literal', () => {
    expect(escapeDollars('Prices: $400-600K and $5 later')).toBe('Prices: \\$400-600K and \\$5 later')
    expect(escapeDollars('[pay](https://x/?q=$1)')).toBe('[pay](https://x/?q=\\$1)')
  })

  test('code, math tags and existing escapes stay as written', () => {
    expect(escapeDollars('run `echo $HOME` or ``a $b``')).toBe('run `echo $HOME` or ``a $b``')
    expect(escapeDollars('already \\$5')).toBe('already \\$5')
    expect(escapeDollars('area <tg-math>$x^2$</tg-math> ok $1')).toBe('area <tg-math>$x^2$</tg-math> ok \\$1')
    const fenced = ['```bash', 'echo $HOME', '```', 'after $1', '~~~', '$x', '~~~'].join('\n')
    expect(escapeDollars(fenced)).toBe(['```bash', 'echo $HOME', '```', 'after \\$1', '~~~', '$x', '~~~'].join('\n'))
  })

  test('an unclosed backtick does not hide the rest of the line', () => {
    expect(escapeDollars('a ` b $1')).toBe('a ` b \\$1')
  })
})

describe('splitText', () => {
  test('cuts at blank lines first, and never past the limit', () => {
    const text = 'a'.repeat(60) + '\n\n' + 'b'.repeat(60)
    expect(splitText(text, 100)).toEqual(['a'.repeat(60), 'b'.repeat(60)])
    for (const part of splitText('x'.repeat(250), 100)) expect(part.length).toBeLessThanOrEqual(100)
    expect(splitText('short', 100)).toEqual(['short'])
  })
})

describe('isRichContentError', () => {
  test('content rejections, not transport errors', () => {
    expect(isRichContentError({ description: 'Bad Request: RICH_MESSAGE_EMPTY' })).toBe(true)
    expect(isRichContentError({ description: "Bad Request: can't parse InputRichBlock" })).toBe(true)
    expect(isRichContentError({ description: 'Too Many Requests: retry after 5' })).toBe(false)
    expect(isRichContentError(new Error('Bad Request: chat not found'))).toBe(false)
  })
})

function fakeRaw(fail?: unknown) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let id = 100
  const raw: RawApi = {
    async sendRichMessage(params) {
      calls.push({ method: 'sendRichMessage', params })
      if (fail) throw fail
      return { message_id: ++id }
    },
    async sendMessage(params) {
      calls.push({ method: 'sendMessage', params })
      return { message_id: ++id }
    },
    async editMessageText(params) {
      calls.push({ method: 'editMessageText', params })
      if (fail && 'rich_message' in params) throw fail
      return true
    },
  }
  return { raw, calls }
}

describe('sendRich', () => {
  test('sends escaped Markdown as a rich message, replying on the first part', async () => {
    const f = fakeRaw()
    const ids = await sendRich({ raw: f.raw, chatId: '42', text: 'costs $5', replyTo: i => (i === 0 ? 7 : undefined) })
    expect(ids).toEqual([101])
    expect(f.calls).toEqual([{
      method: 'sendRichMessage',
      params: {
        chat_id: '42',
        rich_message: { markdown: 'costs \\$5' },
        reply_parameters: { message_id: 7, allow_sending_without_reply: true },
      },
    }])
  })

  test('content Telegram rejects goes out plain, unescaped', async () => {
    const f = fakeRaw({ description: 'Bad Request: RICH_MESSAGE_EMPTY' })
    const ids = await sendRich({ raw: f.raw, chatId: '42', text: 'costs $5', replyTo: () => undefined })
    expect(ids).toEqual([101])
    expect(f.calls.map(c => c.method)).toEqual(['sendRichMessage', 'sendMessage'])
    expect(f.calls[1]!.params.text).toBe('costs $5')
  })

  test('any other error is not swallowed', async () => {
    const f = fakeRaw({ description: 'Too Many Requests: retry after 5' })
    await expect(sendRich({ raw: f.raw, chatId: '42', text: 'x', replyTo: () => undefined })).rejects.toMatchObject({ description: 'Too Many Requests: retry after 5' })
  })
})

describe('editRich', () => {
  test('edits into rich text, or into plain when Telegram rejects it', async () => {
    const ok = fakeRaw()
    await editRich({ raw: ok.raw, chatId: '42', messageId: 9, text: '$1' })
    expect(ok.calls[0]!.params).toEqual({ chat_id: '42', message_id: 9, rich_message: { markdown: '\\$1' } })

    const bad = fakeRaw({ description: 'Bad Request: RICH_MESSAGE_EMPTY' })
    await editRich({ raw: bad.raw, chatId: '42', messageId: 9, text: '$1' })
    expect(bad.calls[1]!.params).toEqual({ chat_id: '42', message_id: 9, text: '$1' })
  })
})
