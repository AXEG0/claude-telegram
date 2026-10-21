import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buttonData, chosen, createButtonStore, drop, GaveUp, judge, join as joinMessage, keyboardOf, keyboardRefused,
  labelProblem, lock, messageGone, notModified, onKeyboard, parseButtonData, parseButtons, pressEvent, RECORD_MAX,
  replace, reserve, restore, take, unreserve, withinLimit, type ButtonRecord,
} from './buttons.ts'
import { metaText } from './reply.ts'
import { cp, lone, PASSING_LABELS, REFUSED_LABELS } from './fixtures/labels.ts'

describe('labels', () => {
  test.each(REFUSED_LABELS)('a label with %s is refused', (_, label) => {
    expect(labelProblem(label)).toBeDefined()
    expect(() => parseButtons([[label]], false)).toThrow('button label')
  })

  test.each(PASSING_LABELS.map(l => [l]))('%s passes and comes back from metaText unchanged', label => {
    expect(labelProblem(label)).toBeUndefined()
    expect(parseButtons([[label]], false)).toEqual([[label]])
    expect(metaText(label, 40)).toBe(label)
  })

  test('rows and sets past the limits, a repeated label and an empty list are refused', () => {
    const row = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `b${from + i}`)
    expect(() => parseButtons([], false)).toThrow('an empty list is refused')
    expect(() => parseButtons([[]], false)).toThrow('1 to 4 rows of 1 to 4 labels')
    expect(() => parseButtons([row(5)], false)).toThrow('1 to 4 rows')
    expect(() => parseButtons([row(1), row(1, 1), row(1, 2), row(1, 3), row(1, 4)], false)).toThrow('1 to 4 rows')
    expect(() => parseButtons('Yes', false)).toThrow('1 to 4 rows')
    expect(() => parseButtons([['Yes', 3]], false)).toThrow('each a string')
    expect(() => parseButtons([['Yes'], ['No', 'Yes']], false)).toThrow('appears twice')
    expect(parseButtons([row(4), row(4, 4), row(4, 8), row(4, 12)], false)).toHaveLength(4)
    // An edit's empty list removes the buttons.
    expect(parseButtons([], true)).toEqual([])
    expect(() => parseButtons([[]], true)).toThrow('1 to 4 rows')
  })
})

describe('keyboards', () => {
  test('each button carries the prefix, the keyboard id and its index, never its label', () => {
    const k = keyboardOf([['Yes', 'No'], ['Later']], 1791544879112)
    expect(k).toEqual({ inline_keyboard: [
      [{ text: 'Yes', callback_data: 'btn:1791544879112:0' }, { text: 'No', callback_data: 'btn:1791544879112:1' }],
      [{ text: 'Later', callback_data: 'btn:1791544879112:2' }],
    ] })
    expect(parseButtonData('btn:1791544879112:2')).toEqual({ keyboard: 1791544879112, index: 2 })
    for (const data of ['perm:allow:abcde', 'permit:p1', 'btn:x:1', 'btn:1:', 'btn:1:123']) expect(parseButtonData(data)).toBeUndefined()
    // The longest data stays far inside Telegram's 64 bytes.
    expect(Buffer.byteLength(buttonData(Number.MAX_SAFE_INTEGER, 15))).toBeLessThan(64)
  })

  test('the choice is one disabled button', () => {
    expect(chosen('Yes')).toEqual({ inline_keyboard: [[{ text: 'Yes', disabled: {} }]] })
  })

  test('a press counts only with its data on the message’s own keyboard', () => {
    const msg = { reply_markup: keyboardOf([['Yes', 'No']], 5) }
    expect(onKeyboard(msg, 'btn:5:1')).toBe('No')
    expect(onKeyboard(msg, 'btn:6:1')).toBeUndefined()
    expect(onKeyboard({}, 'btn:5:1')).toBeUndefined()
    expect(onKeyboard(undefined, 'btn:5:1')).toBeUndefined()
    expect(onKeyboard({ reply_markup: { inline_keyboard: 'x' } }, 'btn:5:1')).toBeUndefined()
  })

  test('a 400 naming the keyboard fails the call that carried it; other errors do not', () => {
    for (const description of ['Bad Request: BUTTON_DATA_INVALID', 'Bad Request: REPLY_MARKUP_INVALID', 'Bad Request: reply markup is too long', 'Bad Request: can\'t parse inline KEYBOARD button']) {
      expect(keyboardRefused({ error_code: 400, description })).toBe(true)
    }
    expect(keyboardRefused({ error_code: 400, description: 'Bad Request: RICH_MESSAGE_MARKDOWN_INVALID' })).toBe(false)
    expect(keyboardRefused({ error_code: 429, description: 'Too Many Requests: button flood' })).toBe(false)
    expect(notModified({ error_code: 400, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same' })).toBe(true)
    expect(messageGone({ error_code: 400, description: 'Bad Request: message to edit not found' })).toBe(true)
  })

  test('a call under the lock gives up in time, and may still land', async () => {
    let aborted = false
    const slow = withinLimit(signal => new Promise(resolve => {
      signal.addEventListener('abort', () => { aborted = true })
      setTimeout(resolve, 500)
    }), 50)
    await expect(slow).rejects.toBeInstanceOf(GaveUp)
    await expect(withinLimit(() => Promise.reject(new Error('x')), 50)).rejects.toThrow('x')
    expect(await withinLimit(async () => 7, 50)).toBe(7)
    expect(aborted).toBe(true)
  })
})

describe('the record', () => {
  const fresh = (): ButtonRecord => ({ next: 100, entries: [] })

  test('a reply reserves an id, sends, then joins its message; a press that came first joins it itself', () => {
    const rec = fresh()
    const k = reserve(rec, '1')
    expect(k).toBe(100)
    expect(rec.next).toBe(101)
    expect(judge(rec, '1', 50, k)).toBe('reserved')
    expect(take(rec, '1', 50, k, 'Yes')).toBe(true)
    expect(rec.entries).toEqual([{ chat: '1', message: 50, keyboard: k, taken: 'Yes' }])
    // The reply's join then leaves the record as it finds it.
    expect(joinMessage(rec, '1', k, 50)).toBe(false)
    expect(rec.entries).toEqual([{ chat: '1', message: 50, keyboard: k, taken: 'Yes' }])
    expect(judge(rec, '1', 50, k)).toBe('taken')
    expect(take(rec, '1', 50, k, 'No')).toBe(false)
  })

  test('a reservation in another chat, or for another keyboard, lets no press count', () => {
    const rec = fresh()
    const k = reserve(rec, '1')
    expect(judge(rec, '2', 50, k)).toBe('closed')
    expect(judge(rec, '1', 50, k + 1)).toBe('closed')
    expect(unreserve(rec, '1', k)).toBe(true)
    expect(rec.entries).toEqual([])
  })

  test('buttons set again open under a new id, and the old one comes back if Telegram refuses', () => {
    const rec = fresh()
    const k1 = reserve(rec, '1')
    joinMessage(rec, '1', k1, 50)
    const k2 = rec.next++
    const was = replace(rec, '1', 50, k2)
    expect(judge(rec, '1', 50, k1)).toBe('closed')
    expect(judge(rec, '1', 50, k2)).toBe('open')
    restore(rec, '1', 50, was)
    expect(judge(rec, '1', 50, k1)).toBe('open')
    // Removal names none as current, then ends the entry once it lands.
    replace(rec, '1', 50, null)
    expect(rec.entries).toEqual([{ chat: '1', message: 50, keyboard: null }])
    drop(rec, '1', 50, null)
    expect(rec.entries).toEqual([])
    // Removing buttons the record never held changes nothing.
    expect(replace(rec, '1', 43, null)).toBeUndefined()
    expect(rec.entries).toEqual([])
  })

  test('a new keyboard clears a pending swap, and a swap ends only the keyboard it showed', () => {
    const rec = fresh()
    const k1 = reserve(rec, '1')
    take(rec, '1', 50, k1, 'Yes')
    const k2 = rec.next++
    replace(rec, '1', 50, k2)
    expect(rec.entries).toEqual([{ chat: '1', message: 50, keyboard: k2 }])
    expect(drop(rec, '1', 50, k1)).toBe(false)
    expect(drop(rec, '1', 50, k2)).toBe(true)
  })

  test(`opening one more than ${RECORD_MAX} drops the oldest, reservations and taken entries included`, () => {
    const rec: ButtonRecord = { next: 5000, entries: [{ chat: '1', keyboard: 1 }, { chat: '1', message: 2, keyboard: 2, taken: 'Yes' }] }
    for (let i = 3; i <= RECORD_MAX; i++) rec.entries.push({ chat: '1', message: i, keyboard: i })
    reserve(rec, '1')
    expect(rec.entries).toHaveLength(RECORD_MAX)
    expect(rec.entries[0]).toEqual({ chat: '1', message: 2, keyboard: 2, taken: 'Yes' })
    replace(rec, '1', 7777, rec.next++)
    expect(rec.entries[0]!.message).toBe(3)
    // Set again, an entry moves to the newest place.
    replace(rec, '1', 3, rec.next++)
    expect(rec.entries[0]!.message).toBe(4)
    expect(rec.entries.at(-1)!.message).toBe(3)
  })
})

describe('the record file', () => {
  const dirs: string[] = []
  const folder = () => {
    const d = mkdtempSync(join(tmpdir(), 'tg-buttons-'))
    dirs.push(d)
    return d
  }
  const store = (dir: string, now = () => 1791544879112, log?: (l: string) => void) =>
    createButtonStore({ file: join(dir, 'buttons.json'), lockFile: join(dir, 'buttons.lock'), now, log })

  test('a new record counts from the clock’s milliseconds, and each write replaces the file whole', async () => {
    const dir = folder()
    const s = store(dir)
    const k = await s.withLock(held => held.update(rec => reserve(rec, '1')))
    expect(k).toBe(1791544879112)
    expect(JSON.parse(readFileSync(join(dir, 'buttons.json'), 'utf8'))).toEqual({ next: 1791544879113, entries: [{ chat: '1', keyboard: k }] })
    // Another clock does not restart the counter of a record that exists.
    expect(await store(dir, () => 5).withLock(held => held.update(rec => reserve(rec, '1')))).toBe(1791544879113)
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  test('an unreadable record is moved aside and a fresh one starts', async () => {
    const dir = folder()
    const lines: string[] = []
    writeFileSync(join(dir, 'buttons.json'), '{"next": "x"')
    const s = store(dir, () => 9, l => lines.push(l))
    expect(await s.withLock(held => held.read())).toEqual({ next: 9, entries: [] })
    expect(readdirSync(dir).filter(f => f.startsWith('buttons.json.corrupt-'))).toHaveLength(1)
    expect(existsSync(join(dir, 'buttons.json'))).toBe(false)
    expect(lines).toEqual(['buttons.json is unreadable, moved aside. Starting fresh.'])
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  test('one holder at a time, the same process’s other holders included, and a wait never stops the event loop', async () => {
    const dir = folder()
    const s = store(dir)
    const order: string[] = []
    let ticks = 0
    const ticker = setInterval(() => ticks++, 5)
    const first = s.withLock(async () => {
      order.push('first in')
      await Bun.sleep(150)
      order.push('first out')
    })
    await Bun.sleep(10)
    const second = s.withLock(() => { order.push('second') })
    await Promise.all([first, second])
    clearInterval(ticker)
    expect(order).toEqual(['first in', 'first out', 'second'])
    expect(ticks).toBeGreaterThan(10)
    // A release lets the next holder in at once.
    const release = await lock(join(dir, 'buttons.lock'))
    release()
    await s.withLock(() => {})
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  test('the event names the label, the message, the presser and the time', () => {
    const at = Date.UTC(2026, 9, 21, 12, 0, 0)
    expect(pressEvent({ chat_id: '1', message_id: 10, label: 'Yes', from: { id: 1, username: 'owner' }, words: 'Merge now?', at })).toEqual({
      content: 'Pressed "Yes" on message 10: "Merge now?"',
      meta: { chat_id: '1', message_id: '10', button: 'Yes', user: 'owner', user_id: '1', ts: '2026-10-21T12:00:00.000Z' },
    })
    expect(pressEvent({ chat_id: '1', message_id: 10, label: 'Yes', from: { id: 5 }, at }).content).toBe('Pressed "Yes" on message 10')
  })
})
