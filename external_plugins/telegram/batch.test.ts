import { describe, expect, test } from 'bun:test'
import { batchGap, BOT_FILE_GAP_MS, createBatcher, FRAGMENT_GAP_MS, MAX_MESSAGES, MAX_WAIT_MS, mergeInbound, PHOTO_GAP_MS, TEXT_GAP_MS, type Inbound } from './batch.ts'

function harness() {
  let t = 0
  let timers: { at: number; fn: () => void; id: number }[] = []
  let id = 0
  const out: Inbound[] = []
  const b = createBatcher({
    deliver: item => out.push(item),
    now: () => t,
    setTimer: (fn, ms) => { timers.push({ at: t + ms, fn, id: ++id }); return id },
    clearTimer: tid => { timers = timers.filter(x => x.id !== tid) },
  })
  const advance = (ms: number) => {
    const end = t + ms
    for (;;) {
      const next = timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      t = next.at
      timers = timers.filter(x => x !== next)
      next.fn()
    }
    t = end
  }
  return { b, out, advance }
}

const msg = (id: number, content: string, extra: Record<string, string> = {}): Inbound =>
  ({ content, meta: { chat_id: '1', message_id: String(id), user: 'owner', ts: `t${id}`, ...extra } })

describe('createBatcher', () => {
  test('a burst of texts goes out once, joined, with every id', () => {
    const h = harness()
    h.b.add('k', 'c', msg(1, 'first'), TEXT_GAP_MS)
    h.advance(200)
    h.b.add('k', 'c', msg(2, 'second'), TEXT_GAP_MS)
    h.advance(200)
    h.b.add('k', 'c', msg(3, 'third'), TEXT_GAP_MS)
    h.advance(TEXT_GAP_MS - 1)
    expect(h.out).toEqual([])
    h.advance(1)
    expect(h.out).toEqual([{ content: 'first\nsecond\nthird', meta: { chat_id: '1', message_id: '3', user: 'owner', ts: 't3', message_ids: '1,2,3' } }])
  })

  test('a text after the gap starts a new batch, and a single message goes out as it came', () => {
    const h = harness()
    h.b.add('k', 'c', msg(1, 'one'), TEXT_GAP_MS)
    h.advance(TEXT_GAP_MS)
    h.b.add('k', 'c', msg(2, 'two'), TEXT_GAP_MS)
    h.advance(TEXT_GAP_MS)
    expect(h.out).toEqual([msg(1, 'one'), msg(2, 'two')])
  })

  test('the pieces of a split paste are glued back, waiting longer after a full piece', () => {
    const h = harness()
    const piece = 'x'.repeat(4096)
    h.b.add('k', 'c', msg(1, piece), FRAGMENT_GAP_MS)
    h.advance(1000)
    h.b.add('k', 'c', msg(2, 'tail'), TEXT_GAP_MS)
    h.advance(TEXT_GAP_MS)
    expect(h.out.map(o => o.content)).toEqual([piece + 'tail'])
  })

  test('a batch goes out at the latest MAX_WAIT_MS after its first message, or when full', () => {
    const h = harness()
    // Full at 12, it goes at once, without waiting for a 13th or the gap.
    for (let i = 1; i <= MAX_MESSAGES; i++) h.b.add('k', 'c', msg(i, `m${i}`), TEXT_GAP_MS)
    expect(h.out.length).toBe(1)
    expect(h.out[0]!.meta.message_ids!.split(',').length).toBe(MAX_MESSAGES)

    // Pieces 1400 ms apart never leave a 1500 ms gap; the batch closes at 7.5 s.
    const g = harness()
    for (let i = 1; i <= 8; i++) { g.b.add('k', 'c', msg(i, `m${i}`), FRAGMENT_GAP_MS); g.advance(1400) }
    g.advance(MAX_WAIT_MS)
    expect(g.out.map(o => o.meta.message_ids)).toEqual(['1,2,3,4,5,6', '7,8'])
  })

  test('photos join the batch, the first as image_path and all in image_paths', () => {
    const h = harness()
    h.b.add('k', 'c', msg(1, '(photo)', { image_path: '/in/a.jpg' }), PHOTO_GAP_MS)
    h.advance(400)
    h.b.add('k', 'c', msg(2, '(photo)', { image_path: '/in/b.jpg' }), PHOTO_GAP_MS)
    h.advance(100)
    h.b.add('k', 'c', msg(3, 'what are these?'), TEXT_GAP_MS)
    h.advance(TEXT_GAP_MS)
    expect(h.out).toEqual([{
      content: '(photo)\n(photo)\nwhat are these?',
      meta: { chat_id: '1', message_id: '3', user: 'owner', ts: 't3', message_ids: '1,2,3', image_path: '/in/a.jpg', image_paths: '/in/a.jpg,/in/b.jpg' },
    }])
  })

  test('a batch waits while the next message is still being prepared', () => {
    const h = harness()
    h.b.add('k', 'c', msg(1, '(photo)', { image_path: '/in/a.jpg' }), PHOTO_GAP_MS)
    h.advance(100)
    h.b.hold('k', 'c')
    h.advance(2000)
    expect(h.out).toEqual([])
    h.b.add('k', 'c', msg(2, '(photo)', { image_path: '/in/b.jpg' }), PHOTO_GAP_MS)
    h.advance(PHOTO_GAP_MS)
    expect(h.out.map(o => o.meta.message_ids)).toEqual(['1,2'])
  })

  test('anything else sends the batch first, then goes alone', () => {
    const h = harness()
    h.b.add('k', 'c', msg(1, 'listen to this'), TEXT_GAP_MS)
    h.b.flush('k', msg(2, '(voice message)', { attachment_kind: 'voice', attachment_file_id: 'v1' }))
    expect(h.out).toEqual([msg(1, 'listen to this'), msg(2, '(voice message)', { attachment_kind: 'voice', attachment_file_id: 'v1' })])
  })

  test('another bot\'s files wait 3 s for the text sent after them, and go out with it as one message', () => {
    const h = harness()
    const doc = (id: number, name: string, extra: Record<string, string> = {}) =>
      msg(id, `(document: ${name})`, { attachment_kind: 'document', attachment_file_id: `f${id}`, attachment_name: name, ...extra })
    h.b.add('k', 'c', doc(1, 'a.txt'), BOT_FILE_GAP_MS)
    h.b.add('k', 'c', doc(2, 'b.txt'), BOT_FILE_GAP_MS)
    h.advance(BOT_FILE_GAP_MS - 1)
    expect(h.out).toEqual([])
    h.b.add('k', 'c', msg(3, 'both files attached'), TEXT_GAP_MS)
    h.advance(TEXT_GAP_MS)
    expect(h.out.map(o => [o.content, o.meta.message_ids, o.meta.attachment_file_ids])).toEqual([
      ['(document: a.txt)\n(document: b.txt)\nboth files attached', '1,2,3', 'f1,f2'],
    ])
  })

  test('in a group, another sender\'s message sends the waiting batch first, so the chat keeps its order', () => {
    const h = harness()
    h.b.add('c:x', 'c', msg(1, 'x'.repeat(4096)), FRAGMENT_GAP_MS)
    h.advance(200)
    h.b.hold('c:y', 'c')
    expect(h.out.map(o => o.meta.message_id)).toEqual(['1'])
    h.b.add('c:y', 'c', msg(2, 'agreed'), TEXT_GAP_MS)
    h.b.add('d:x', 'd', msg(3, 'elsewhere'), TEXT_GAP_MS)
    h.advance(TEXT_GAP_MS)
    expect(h.out.map(o => o.meta.message_id)).toEqual(['1', '2', '3'])
  })

  test('another sender\'s batch goes first even without a hold', () => {
    const h = harness()
    h.b.add('c:x', 'c', msg(1, '(photo)', { image_path: '/in/a.jpg' }), PHOTO_GAP_MS)
    h.b.add('c:y', 'c', msg(2, 'nice'), TEXT_GAP_MS)
    h.advance(PHOTO_GAP_MS)
    expect(h.out.map(o => o.meta.message_id)).toEqual(['1', '2'])
  })

  test('a message replying to another message than the batch\'s starts a new batch', () => {
    const h = harness()
    h.b.add('k', 'c', msg(1, 'a', { reply_to_message_id: '10' }), TEXT_GAP_MS)
    h.b.add('k', 'c', msg(2, 'more on that'), TEXT_GAP_MS)
    h.b.add('k', 'c', msg(3, 'b', { reply_to_message_id: '20' }), TEXT_GAP_MS)
    h.advance(TEXT_GAP_MS)
    expect(h.out.map(o => [o.meta.message_ids ?? o.meta.message_id, o.meta.reply_to_message_id])).toEqual([['1,2', '10'], ['3', '20']])
  })

  test('flushChat sends every batch of the chat, and only that chat\'s', () => {
    const h = harness()
    h.b.add('c:x', 'c', msg(1, 'x said'), TEXT_GAP_MS)
    h.b.add('d:x', 'd', msg(3, 'elsewhere'), TEXT_GAP_MS)
    h.b.flushChat('c')
    expect(h.out.map(o => o.meta.message_id)).toEqual(['1'])
  })

  test('after flushAll a message goes out at once, as the server is stopping', async () => {
    const h = harness()
    h.b.add('k', 'c', msg(1, 'before'), TEXT_GAP_MS)
    await h.b.flushAll()
    h.b.add('k', 'c', msg(2, 'fetched during shutdown'), PHOTO_GAP_MS)
    expect(h.out.map(o => o.meta.message_id)).toEqual(['1', '2'])
  })

  test('flushAll sends every waiting batch and waits for the sends', async () => {
    const sent: string[] = []
    const b = createBatcher({ deliver: async item => { await Bun.sleep(5); sent.push(item.meta.message_id!) } })
    b.add('a', 'c', msg(1, 'one'), TEXT_GAP_MS)
    b.add('b', 'd', msg(2, 'two'), TEXT_GAP_MS)
    await b.flushAll()
    expect(sent.sort()).toEqual(['1', '2'])
  })
})

describe('batchGap', () => {
  test('photos, documents and plain text batch, a bot\'s file waiting longest; voice, other files and a person\'s commands go alone', () => {
    for (const bot of [false, true]) {
      expect(batchGap({ text: 'hi', file: false, other: false, bot })).toBe(TEXT_GAP_MS)
      expect(batchGap({ text: 'x'.repeat(4096), file: false, other: false, bot })).toBe(FRAGMENT_GAP_MS)
      expect(batchGap({ text: '(voice message)', file: false, other: true, bot })).toBeUndefined()
    }
    // A photo, downloaded or not, and a document.
    expect(batchGap({ text: '(photo)', file: true, other: false, bot: false })).toBe(PHOTO_GAP_MS)
    expect(batchGap({ text: '(document: a.pdf)', file: true, other: false, bot: false })).toBe(PHOTO_GAP_MS)
    expect(batchGap({ text: '(document: a.pdf)', file: true, other: false, bot: true })).toBe(BOT_FILE_GAP_MS)
    expect(BOT_FILE_GAP_MS).toBe(3000)
    // A person's command goes alone; a bot's text starting with / is text.
    expect(batchGap({ text: '/compact', file: false, other: false, bot: false })).toBeUndefined()
    expect(batchGap({ text: '/tmp/out.json is attached', file: false, other: false, bot: true })).toBe(TEXT_GAP_MS)
  })
})

describe('mergeInbound', () => {
  test('keeps the first reply context, whichever message carries it', () => {
    const merged = mergeInbound([
      msg(1, 'a'),
      msg(2, 'b', { reply_to_message_id: '40', reply_to_user: 'this bot', reply_quote: 'q' }),
      msg(3, 'c', { reply_to_message_id: '41', reply_to_text: 'other' }),
    ])
    expect(merged.meta).toEqual({ chat_id: '1', message_id: '3', user: 'owner', ts: 't3', message_ids: '1,2,3', reply_to_message_id: '40', reply_to_user: 'this bot', reply_quote: 'q' })
  })

  test('a text and two files: the first file\'s attachment keys and none of the last one\'s, and every file\'s id and name in message order', () => {
    const merged = mergeInbound([
      msg(1, 'the report and its data'),
      msg(2, '(document: report,final.pdf)', { attachment_kind: 'document', attachment_file_id: 'f1', attachment_name: 'report,final.pdf' }),
      msg(3, '(document: file)', { attachment_kind: 'document', attachment_file_id: 'f2', attachment_size: '10', attachment_mime: 'text/csv' }),
    ])
    expect(merged).toEqual({
      content: 'the report and its data\n(document: report,final.pdf)\n(document: file)',
      meta: {
        chat_id: '1', message_id: '3', user: 'owner', ts: 't3', message_ids: '1,2,3',
        attachment_kind: 'document', attachment_file_id: 'f1', attachment_name: 'report,final.pdf',
        attachment_file_ids: 'f1,f2', attachment_names: 'report_final.pdf,',
      },
    })
    // One file: its keys, and no lists.
    const one = mergeInbound([msg(1, 'look'), msg(2, '(document: a.txt)', { attachment_kind: 'document', attachment_file_id: 'f2', attachment_name: 'a.txt' })])
    expect(one.meta).toEqual({ chat_id: '1', message_id: '2', user: 'owner', ts: 't2', message_ids: '1,2', attachment_kind: 'document', attachment_file_id: 'f2', attachment_name: 'a.txt' })
  })
})
