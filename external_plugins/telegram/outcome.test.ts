// What a failed send or edit tells Claude (outcome.ts), read from the errors
// grammY's own client raises against a real local socket wherever one can
// raise them, so a Bun or grammY release that names them differently fails
// here.
import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server, type Socket } from 'node:net'
import { Api, GrammyError } from 'grammy'
import { GaveUp, withinLimit } from './buttons.ts'
import { outcomeOf, outcomeText, SendOutcome, stopped, UNKNOWN_EDIT, UNKNOWN_SEND } from './outcome.ts'

const servers: Server[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

// A local server that does what it is told with each request's socket.
function serve(onRequest: (socket: Socket) => void): Promise<string> {
  const server = createServer(socket => {
    socket.on('error', () => {})
    socket.once('data', () => onRequest(socket))
  })
  servers.push(server)
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`)))
}
const answer = (status: string, type: string, body: string) => (socket: Socket) =>
  socket.end(`HTTP/1.1 ${status}\r\ncontent-type: ${type}\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`)
const json = (body: object) => answer('200 OK', 'application/json', JSON.stringify(body))

// The error a send to root raises.
async function sendError(root: string, timeoutSeconds?: number): Promise<unknown> {
  return new Api('1:test', { apiRoot: root, ...(timeoutSeconds ? { timeoutSeconds } : {}) }).sendMessage(1, 'x').then(() => undefined, err => err)
}

describe('not sent', () => {
  test('a 429 reads as not sent with the wait Telegram asks for', async () => {
    const err = await sendError(await serve(json({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } })))
    expect(err).toBeInstanceOf(GrammyError)
    const o = outcomeOf(err)
    expect(o).toEqual({ sent: 'no', wait: 7, cause: 'Telegram answered 429: Too Many Requests: retry after 7' })
    expect(outcomeText(o!)).toBe('not sent; Telegram asks to wait 7 s')
    expect(outcomeText(o!, true)).toBe('not edited; Telegram asks to wait 7 s')
  })

  test('any other 4xx reads as not sent', async () => {
    for (const [code, description] of [[400, 'Bad Request: chat not found'], [403, 'Forbidden: bot was blocked by the user']] as const) {
      const o = outcomeOf(await sendError(await serve(json({ ok: false, error_code: code, description }))))
      expect(o).toEqual({ sent: 'no', cause: `Telegram answered ${code}: ${description}` })
      expect(outcomeText(o!)).toBe('not sent')
    }
  })

  test('a refused connection reads as not sent', async () => {
    const closed = createServer()
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as { port: number }).port
    await new Promise<void>(resolve => closed.close(() => resolve()))
    const o = outcomeOf(await sendError(`http://127.0.0.1:${port}`))
    expect(o?.sent).toBe('no')
    expect(o && 'wait' in o).toBe(false)
  })

  test('a name the lookup cannot find reads as not sent', async () => {
    const o = outcomeOf(await sendError('http://no-such-host.invalid'))
    expect(o?.sent).toBe('no')
  }, 15_000)
})

describe('unknown', () => {
  test('a 5xx, as Telegram\'s 504 after it held a send, reads as unknown, whether its body is JSON or a gateway\'s page', async () => {
    const answered = outcomeOf(await sendError(await serve(answer('504 Gateway Timeout', 'application/json', JSON.stringify({ ok: false, error_code: 504, description: 'Gateway Timeout' })))))
    expect(answered).toEqual({ sent: 'unknown', cause: 'Telegram answered 504: Gateway Timeout' })
    expect(outcomeText(answered!)).toBe(UNKNOWN_SEND)
    expect(outcomeText(answered!, true)).toBe(UNKNOWN_EDIT)
    expect(outcomeOf(await sendError(await serve(answer('504 Gateway Time-out', 'text/html', '<html>504 Gateway Time-out</html>'))))?.sent).toBe('unknown')
  })

  test('grammY\'s own timeout reads as unknown', async () => {
    const err = await sendError(await serve(() => {}), 0.3)
    expect(String((err as { error?: Error }).error?.message)).toContain('timed out after 0.3 seconds')
    expect(outcomeOf(err)).toEqual({ sent: 'unknown', cause: "Request to 'sendMessage' timed out after 0.3 seconds" })
  })

  test('a connection dropped before the answer reads as unknown', async () => {
    const o = outcomeOf(await sendError(await serve(socket => socket.destroy())))
    expect(o?.sent).toBe('unknown')
    expect(o?.cause).toContain('ECONNRESET')
  })

  test('a call under the button lock that gave up waiting reads as unknown', async () => {
    const err = await withinLimit(() => new Promise(() => {}), 50).then(() => undefined, e => e)
    expect(err).toBeInstanceOf(GaveUp)
    expect(outcomeOf(err)).toEqual({ sent: 'unknown', cause: 'Telegram did not answer within 0.05 s' })
  })

  test('the texts say what to do', () => {
    expect(UNKNOWN_SEND).toBe('delivery unknown: Telegram may still deliver it, even minutes later; do not resend unless the recipient says it did not arrive')
    expect(UNKNOWN_EDIT).toBe('edit outcome unknown; repeating the same edit is safe')
  })
})

test('an error that did not come from the call to Telegram is left as it is', () => {
  expect(outcomeOf(new Error('the username Telegram gives for 7 is chat 8, not 7'))).toBeUndefined()
  expect(outcomeOf('text')).toBeUndefined()
})

describe('a reply that stopped', () => {
  const unknown = { sent: 'unknown' as const, cause: 'Telegram answered 504: Gateway Timeout' }
  test('names the part, how it ended and why, the messages already sent with their ids, and the parts never tried', () => {
    const e = stopped({ outcome: unknown, part: 2, total: 4, sent: [100] })
    expect(e).toBeInstanceOf(SendOutcome)
    expect(e.outcome).toBe(unknown)
    expect(e.message).toBe(`part 2 of 4: ${UNKNOWN_SEND} (Telegram answered 504: Gateway Timeout); sent so far: 1 message(s) (ids: 100); never tried: parts 3 to 4`)
    expect(stopped({ outcome: { sent: 'no', wait: 3, cause: 'c' }, part: 2, total: 3, sent: [], what: 'an album of 3 documents' }).message)
      .toBe('part 2 of 3 (an album of 3 documents): not sent; Telegram asks to wait 3 s (c); sent so far: none; never tried: part 3')
    expect(stopped({ outcome: unknown, part: 3, total: 3, sent: [1, 2] }).message)
      .toBe(`part 3 of 3: ${UNKNOWN_SEND} (Telegram answered 504: Gateway Timeout); sent so far: 2 message(s) (ids: 1, 2); never tried: none`)
  })

  test('of one part says only how it ended, and that its buttons are kept when told', () => {
    expect(stopped({ outcome: unknown, part: 1, total: 1, sent: [] }).message).toBe(`${UNKNOWN_SEND} (Telegram answered 504: Gateway Timeout)`)
    expect(stopped({ outcome: unknown, part: 1, total: 1, sent: [], kept: true }).message)
      .toBe(`${UNKNOWN_SEND} (Telegram answered 504: Gateway Timeout); its buttons are kept, so a press on them counts if it arrives`)
  })
})
