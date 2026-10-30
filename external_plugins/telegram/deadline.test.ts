// The deadlines on the calls that hold polling (deadline.ts), against grammY
// itself: its poll loop, its start-up retries and its client over a real
// socket. Limits here are a fraction of a second, so the tests run in real
// time; the server's own 45 s, on the driven clock, is in
// deadline.integration.test.ts.
import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server, type Socket } from 'node:net'
import { Bot, HttpError } from 'grammy'
import { deadlineOf, deadlineTransformer, pollError, POLL_MARGIN_MS, START_CALL_MS } from './deadline.ts'

const servers: Server[] = []
const bots: Bot[] = []
afterEach(async () => {
  for (const bot of bots.splice(0)) if (bot.isRunning()) await bot.stop().catch(() => {})
  for (const server of servers.splice(0)) server.close()
})

describe('the deadline of each call', () => {
  test('a poll gets its poll time plus 15 s, one without a poll time the margin alone, getMe and deleteWebhook 30 s, and every other call none', () => {
    expect(POLL_MARGIN_MS).toBe(15_000)
    expect(START_CALL_MS).toBe(30_000)
    expect(deadlineOf('getUpdates', { offset: 5, timeout: 30 })).toBe(45_000)
    expect(deadlineOf('getUpdates', { offset: 5, limit: 1 })).toBe(15_000)
    expect(deadlineOf('getUpdates', undefined)).toBe(15_000)
    expect(deadlineOf('getMe', {})).toBe(30_000)
    expect(deadlineOf('deleteWebhook', {})).toBe(30_000)
    for (const method of ['sendMessage', 'sendDocument', 'sendMediaGroup', 'answerCallbackQuery', 'editMessageText', 'getFile', 'setMyCommands']) {
      expect(deadlineOf(method, {})).toBeUndefined()
    }
  })
})

type Prev = (method: string, payload: unknown, signal?: AbortSignal) => Promise<any>
const call = (t: ReturnType<typeof deadlineTransformer>, prev: Prev, method: string, payload: unknown, signal?: AbortSignal) =>
  t(prev as never, method, payload as never, signal)

describe('the deadline transformer', () => {
  test('a poll with no answer fails at its deadline with grammY\'s HttpError, its request aborted, its late answer never read, and one line in the log', async () => {
    const lines: string[] = []
    const t = deadlineTransformer({ pollMarginMs: 200, log: line => lines.push(line) })
    let seen: AbortSignal | undefined
    let answered = false
    // An answer that ignores the abort and comes after the deadline.
    const prev: Prev = (_m, _p, signal) => { seen = signal; return Bun.sleep(400).then(() => { answered = true; return { ok: true, result: [{ update_id: 7 }] } }) }
    const started = performance.now()
    const err = await call(t, prev, 'getUpdates', { offset: 7, timeout: 0 }).then(() => undefined, e => e)
    const took = performance.now() - started
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).error).toBeInstanceOf(Error)
    expect(((err as HttpError).error as Error).message).toBe('no answer within 0.2 s')
    expect(took).toBeGreaterThanOrEqual(190)
    expect(took).toBeLessThan(380)
    expect(seen?.aborted).toBe(true)
    expect(answered).toBe(false)
    expect(lines).toEqual(['poll failed after 0.2 s: no answer within 0.2 s'])
    await Bun.sleep(300)
    expect(answered).toBe(true)
    expect(lines).toHaveLength(1)
  })

  test('grammY\'s own abort still ends a poll, which writes no line, and the listener on grammY\'s signal goes once each call ends', async () => {
    const lines: string[] = []
    const t = deadlineTransformer({ pollMarginMs: 5000, log: line => lines.push(line) })
    const stop = new AbortController()
    let added = 0
    let removed = 0
    const add = stop.signal.addEventListener.bind(stop.signal)
    const remove = stop.signal.removeEventListener.bind(stop.signal)
    stop.signal.addEventListener = ((...args: Parameters<typeof add>) => { added++; return add(...args) }) as typeof add
    stop.signal.removeEventListener = ((...args: Parameters<typeof remove>) => { removed++; return remove(...args) }) as typeof remove
    // A poll that ends only on its signal, as a fetch does.
    const prev: Prev = (_m, _p, signal) => new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new HttpError("Network request for 'getUpdates' failed!", new DOMException('The operation was aborted.', 'AbortError')))))
    // Three answered calls, each leaving no listener behind.
    for (let i = 0; i < 3; i++) await call(t, async () => ({ ok: true, result: [] }), 'getUpdates', { timeout: 30 }, stop.signal)
    expect([added, removed]).toEqual([3, 3])
    const pending = call(t, prev, 'getUpdates', { offset: 1, timeout: 30 }, stop.signal).then(() => undefined, e => e)
    stop.abort()
    expect(await pending).toBeInstanceOf(HttpError)
    expect([added, removed]).toEqual([4, 4])
    expect(lines).toEqual([])
  })

  test('a poll Telegram refuses writes one line with the error and its time, except a conflict (409) or a refused token (401), and a thrown error one line with what it says', async () => {
    const lines: string[] = []
    const t = deadlineTransformer({ log: line => lines.push(line) })
    for (const [code, description] of [[502, 'Bad Gateway'], [429, 'Too Many Requests: retry after 3'], [409, 'Conflict: terminated by other getUpdates request'], [401, 'Unauthorized']] as const) {
      const res = await call(t, async () => ({ ok: false, error_code: code, description }), 'getUpdates', { timeout: 30 })
      expect(res.ok).toBe(false)
    }
    const reset = new HttpError("Network request for 'getUpdates' failed!", Object.assign(new TypeError('The socket connection was closed unexpectedly.'), { code: 'ECONNRESET' }))
    await call(t, async () => { throw reset }, 'getUpdates', { timeout: 30 }).catch(() => {})
    expect(lines).toEqual([
      'poll failed after 0.0 s: 502: Bad Gateway',
      'poll failed after 0.0 s: 429: Too Many Requests: retry after 3',
      'poll failed after 0.0 s: ECONNRESET: The socket connection was closed unexpectedly.',
    ])
    expect(pollError(new HttpError('x', Object.assign(new TypeError('ECONNREFUSED: Unable to connect.'), { code: 'ECONNREFUSED' })))).toBe('ECONNREFUSED: Unable to connect.')
  })

  test('a call without a deadline gets grammY\'s own signal and no limit, and a failed start-up call writes no line', async () => {
    const lines: string[] = []
    const t = deadlineTransformer({ pollMarginMs: 50, startMs: 50, log: line => lines.push(line) })
    const signal = new AbortController().signal
    let seen: AbortSignal | undefined
    const res = await call(t, async (_m, _p, s) => { seen = s; await Bun.sleep(150); return { ok: true, result: true } }, 'sendMessage', { chat_id: 1, text: 'x' }, signal)
    expect(res.ok).toBe(true)
    expect(seen).toBe(signal)
    const err = await call(t, () => Bun.sleep(150).then(() => ({ ok: true })), 'getMe', {}).then(() => undefined, e => e)
    expect(err).toBeInstanceOf(HttpError)
    expect(lines).toEqual([])
  })
})

// A raw HTTP/1.1 server on a local port that answers grammY as the test says:
// each request goes to answer() with its socket's number; answer() writes the
// answer or nothing. It records when each socket opened and closed.
function rawServer(answer: (req: { socket: number; method: string; body: Record<string, unknown> }, reply: (body: object) => void) => void) {
  const sockets: { opened: number; closed?: number }[] = []
  const server = createServer((socket: Socket) => {
    const id = sockets.length
    const record: { opened: number; closed?: number } = { opened: performance.now() }
    sockets.push(record)
    socket.on('close', () => { record.closed = performance.now() })
    socket.on('error', () => {})
    let buf = Buffer.alloc(0)
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const end = buf.indexOf('\r\n\r\n')
        if (end < 0) return
        const head = buf.subarray(0, end).toString()
        const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0)
        if (buf.length < end + 4 + length) return
        const text = buf.subarray(end + 4, end + 4 + length).toString()
        buf = buf.subarray(end + 4 + length)
        const method = head.split(' ')[1]!.split('/').pop()!
        const reply = (body: object) => {
          const json = JSON.stringify(body)
          socket.write(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(json)}\r\nconnection: keep-alive\r\n\r\n${json}`)
        }
        answer({ socket: id, method, body: text ? JSON.parse(text) : {} }, reply)
      }
    })
  })
  servers.push(server)
  return new Promise<{ root: string; sockets: typeof sockets }>(resolve => server.listen(0, '127.0.0.1', () => {
    resolve({ root: `http://127.0.0.1:${(server.address() as { port: number }).port}`, sockets })
  }))
}

const ME = { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' }

describe('over a real socket', () => {
  test('a poll with no answer is cut at its deadline: its socket closes then, and the next poll comes 3 s later from the same offset on another connection', async () => {
    const polls: { socket: number; at: number; offset: unknown }[] = []
    const { root, sockets } = await rawServer((req, reply) => {
      if (req.method === 'getMe') return reply({ ok: true, result: ME })
      if (req.method === 'deleteWebhook') return reply({ ok: true, result: true })
      if (req.method !== 'getUpdates') return reply({ ok: true, result: true })
      // grammY's last poll on stop carries no poll time and is answered; a
      // long poll is not.
      if (!('timeout' in req.body)) return reply({ ok: true, result: [] })
      polls.push({ socket: req.socket, at: performance.now(), offset: req.body.offset })
    })
    const lines: string[] = []
    const bot = new Bot('1:test', { client: { apiRoot: root } })
    bots.push(bot)
    bot.api.config.use(deadlineTransformer({ pollMarginMs: 400, log: line => lines.push(line) }))
    void bot.start({ timeout: 1 }).catch(() => {})
    const until = async (check: () => boolean, ms: number) => {
      const end = performance.now() + ms
      while (!check()) {
        if (performance.now() > end) throw new Error('not reached in time')
        await Bun.sleep(5)
      }
    }
    await until(() => polls.length >= 2, 8000)
    const [first, second] = polls as [typeof polls[0], typeof polls[0]]
    const cut = sockets[first.socket]!.closed
    expect(cut).toBeDefined()
    // Closed at the deadline, 1 s of poll time plus 0.4 s.
    expect(cut! - first.at).toBeGreaterThanOrEqual(1390)
    expect(cut! - first.at).toBeLessThan(1700)
    // grammY's 3 s wait after a failed poll, counted from the cut.
    expect(second.at - first.at).toBeGreaterThanOrEqual(4390)
    expect(second.at - first.at).toBeLessThan(4800)
    // Another live connection: one Bun's pool held open, or a new one.
    expect(second.socket).not.toBe(first.socket)
    expect(sockets[second.socket]!.closed).toBeUndefined()
    expect(second.offset).toEqual(first.offset)
    expect(lines).toEqual(['poll failed after 1.4 s: no answer within 1.4 s'])
  }, 15_000)

  test('a getMe with no answer is cut at its deadline and grammY tries it again, so polling starts once Telegram answers', async () => {
    let getMes = 0
    const { root } = await rawServer((req, reply) => {
      if (req.method === 'getMe') { if (++getMes > 1) reply({ ok: true, result: ME }); return }
      if (req.method === 'getUpdates' && 'timeout' in req.body) return
      reply({ ok: true, result: req.method === 'getUpdates' ? [] : true })
    })
    const bot = new Bot('1:test', { client: { apiRoot: root } })
    bots.push(bot)
    bot.api.config.use(deadlineTransformer({ startMs: 300 }))
    let started = 0
    let failed: unknown
    const t0 = performance.now()
    void bot.start({ timeout: 1, onStart: () => { started = performance.now() } }).catch(err => { failed = err })
    const end = performance.now() + 5000
    while (!started && !failed && performance.now() < end) await Bun.sleep(5)
    expect(failed).toBeUndefined()
    expect(getMes).toBe(2)
    expect(started - t0).toBeGreaterThanOrEqual(290)
    expect(started - t0).toBeLessThan(1500)
  }, 10_000)
})
