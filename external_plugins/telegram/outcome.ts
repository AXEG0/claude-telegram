// What a failed send or edit tells Claude: whether the message went, so it
// knows whether sending it again is safe. Telegram's Bot API has no
// idempotency key, so a send Telegram took but never answered can still
// arrive, even minutes later, and a second copy would arrive beside it.
//
// - Not sent: Telegram answered with a 4xx, a 429 with the wait it asks for,
//   or the request never left, its connection refused or its host's name not
//   found.
// - Unknown: Telegram answered with a 5xx, or no answer came: a timeout, a
//   dropped connection or any other network error, or a call made under the
//   button lock that gave up waiting.
//
// Any other error did not come from the call to Telegram, and is left as it
// is. Nothing here sends again.

import { GrammyError, HttpError } from 'grammy'
import { GaveUp } from './buttons.ts'

export type Outcome =
  | { sent: 'no'; wait?: number; cause: string }
  | { sent: 'unknown'; cause: string }

// The codes of a request that never left: Bun names a refused connection
// ConnectionRefused up to 1.3 (a name not found too) and ECONNREFUSED from
// 1.4, where a name not found is ENOTFOUND, or EAI_AGAIN while the lookup
// itself fails.
const NEVER_LEFT = new Set(['ConnectionRefused', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])

export const UNKNOWN_SEND = 'delivery unknown: Telegram may still deliver it, even minutes later; do not resend unless the recipient says it did not arrive'
export const UNKNOWN_EDIT = 'edit outcome unknown; repeating the same edit is safe'

export function outcomeOf(err: unknown): Outcome | undefined {
  if (err instanceof GrammyError) {
    const cause = `Telegram answered ${err.error_code}: ${err.description}`
    if (err.error_code === 429) {
      const wait = err.parameters?.retry_after
      return { sent: 'no', ...(typeof wait === 'number' ? { wait } : {}), cause }
    }
    if (err.error_code >= 400 && err.error_code < 500) return { sent: 'no', cause }
    return { sent: 'unknown', cause }
  }
  if (err instanceof HttpError) {
    const inner = err.error as { code?: unknown; message?: unknown } | undefined
    const text = typeof inner?.message === 'string' ? inner.message : err.message
    const code = typeof inner?.code === 'string' ? inner.code : undefined
    const cause = code && !text.includes(code) ? `${code}: ${text}` : text
    return NEVER_LEFT.has(code ?? '') ? { sent: 'no', cause } : { sent: 'unknown', cause }
  }
  if (err instanceof GaveUp) return { sent: 'unknown', cause: `Telegram did not answer within ${err.ms / 1000} s` }
  return undefined
}

// The verdict alone: not sent (and the wait asked for), or unknown.
export function outcomeText(o: Outcome, edit = false): string {
  if (o.sent === 'unknown') return edit ? UNKNOWN_EDIT : UNKNOWN_SEND
  const not = edit ? 'not edited' : 'not sent'
  return o.wait !== undefined ? `${not}; Telegram asks to wait ${o.wait} s` : not
}

// A send of a reply that failed with a known outcome: thrown by the reply
// tool, so its result says no "failed" when the outcome is unknown.
export class SendOutcome extends Error {
  constructor(message: string, readonly outcome: Outcome) {
    super(message)
  }
}

// The result of a reply that stopped at one of its parts (a text part, a file,
// or to another bot an album): the part, how it ended, the messages already
// sent and the parts never tried. A reply of one part says only how it ended.
// kept: the part carried the reply's buttons, whose record is kept, since the
// message may still arrive with them.
export function stopped(p: {
  outcome: Outcome
  part: number
  total: number
  sent: number[]
  what?: string
  kept?: boolean
}): SendOutcome {
  const { outcome, part, total, sent } = p
  const head = total > 1 ? `part ${part} of ${total}${p.what ? ` (${p.what})` : ''}: ` : ''
  const so = sent.length ? `${sent.length} message(s) (ids: ${sent.join(', ')})` : 'none'
  const never = part >= total ? 'none' : part + 1 === total ? `part ${total}` : `parts ${part + 1} to ${total}`
  const tail = total > 1 ? `; sent so far: ${so}; never tried: ${never}` : ''
  const buttons = p.kept ? '; its buttons are kept, so a press on them counts if it arrives' : ''
  return new SendOutcome(`${head}${outcomeText(outcome)} (${outcome.cause})${tail}${buttons}`, outcome)
}
