// Deadlines on the Telegram calls that hold polling. grammY's client waits up
// to 500 seconds for any call, and its poll loop waits on each getUpdates, so
// a poll Telegram never answers holds every inbound message that long. Here
// each getUpdates gets its poll time plus POLL_MARGIN_MS, and the start-up
// getMe and deleteWebhook get START_CALL_MS. At the deadline the call is
// aborted, which closes its connection, and it fails at once with grammY's own
// HttpError, whether or not the abort is heard. grammY then asks again: a poll
// 3 seconds later from the same offset, on a fresh connection; a start-up call
// with its own growing wait. An answer that comes after the deadline is never
// read, so nothing is lost or handled twice. Every other call keeps grammY's
// limit.
//
// Every failed poll writes one line to the log, with its error and how long it
// took, so a stall shows whether Telegram hung or refused. A conflict (409) or
// a refused token (401) is the plugin's poll loop's to log, since grammY hands
// it there, and a poll grammY cancelled itself, as on stop, is no failure.

import { HttpError } from 'grammy'

export const POLL_MARGIN_MS = 15_000
export const START_CALL_MS = 30_000

export type Limits = { pollMarginMs?: number; startMs?: number }

// The deadline of a call in milliseconds; undefined for a call that keeps
// grammY's limit. A getUpdates without a poll time, as grammY's last one on
// stop, gets the margin alone.
export function deadlineOf(method: string, payload: unknown, limits: Limits = {}): number | undefined {
  if (method === 'getUpdates') {
    const timeout = Number((payload as { timeout?: unknown } | undefined)?.timeout)
    return (Number.isFinite(timeout) && timeout > 0 ? timeout * 1000 : 0) + (limits.pollMarginMs ?? POLL_MARGIN_MS)
  }
  if (method === 'getMe' || method === 'deleteWebhook') return limits.startMs ?? START_CALL_MS
  return undefined
}

// What a failed poll's line says went wrong.
export function pollError(err: unknown): string {
  if (err instanceof HttpError) {
    const cause = err.error as { code?: unknown; message?: unknown } | undefined
    const text = typeof cause?.message === 'string' ? cause.message : String(cause ?? err.message)
    const code = typeof cause?.code === 'string' && !text.includes(cause.code) ? `${cause.code}: ` : ''
    return `${code}${text}`
  }
  return err instanceof Error ? err.message : String(err)
}

type Answer = { ok: boolean; error_code?: number; description?: string }

// A grammY API transformer. Installed first, it is the innermost, so a call it
// ends is a failed call to every transformer installed after it.
export function deadlineTransformer(opts: Limits & { log?: (line: string) => void; now?: () => number } = {}) {
  const now = opts.now ?? Date.now
  const log = opts.log ?? (() => {})
  return async <M extends string, P, R extends Answer>(
    prev: (method: M, payload: P, signal?: AbortSignal) => Promise<R>,
    method: M,
    payload: P,
    signal?: AbortSignal,
  ): Promise<R> => {
    const ms = deadlineOf(method, payload, opts)
    if (ms === undefined) return prev(method, payload, signal)
    const started = now()
    const took = () => `${((now() - started) / 1000).toFixed(1)} s`
    const poll = method === 'getUpdates'
    // grammY's own signal, which stop() aborts, still ends the call; its
    // listener goes once the call ends, so none builds up on it.
    const controller = new AbortController()
    const cancel = () => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', cancel)
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new HttpError(`Network request for '${method}' failed!`, new Error(`no answer within ${ms / 1000} s`)))
        controller.abort()
      }, ms)
    })
    try {
      const res = await Promise.race([prev(method, payload, controller.signal), late])
      if (poll && !res.ok && res.error_code !== 401 && res.error_code !== 409) {
        log(`poll failed after ${took()}: ${res.error_code}: ${res.description}`)
      }
      return res
    } catch (err) {
      if (poll && !signal?.aborted) log(`poll failed after ${took()}: ${pollError(err)}`)
      throw err
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
  }
}
