// Polling heartbeat: proof, readable from outside the process, that the
// getUpdates long-poll is completing. A live process whose poll loop has hung
// looks healthy to a process check; the heartbeat goes stale instead.
//
// Each getUpdates call that returns ok rewrites the file with the poller's pid
// and the time, through a temp file and a rename so a reader never sees a
// partial write. An idle long-poll returns at least every 30 seconds, so a
// fresh heartbeat is never older than that plus one request's latency.

import { renameSync, writeFileSync } from 'fs'

export type Heartbeat = { pid: number; at: number }

export function writeHeartbeat(file: string, pid: number, at: number): void {
  const tmp = `${file}.${pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ pid, at } satisfies Heartbeat) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

// A grammy API transformer. A failed poll (a thrown network error, a 409, or a
// response with ok false) writes nothing, and a failed write never reaches the
// poll loop: the heartbeat reports polling, it must not be able to stop it.
export function heartbeatTransformer(
  file: string,
  pid: number,
  now: () => number = Date.now,
  write: typeof writeHeartbeat = writeHeartbeat,
  onWriteError: (err: unknown) => void = () => {},
) {
  return async <M extends string, P, R extends { ok: boolean }>(
    prev: (method: M, payload: P, signal?: AbortSignal) => Promise<R>,
    method: M,
    payload: P,
    signal?: AbortSignal,
  ): Promise<R> => {
    const result = await prev(method, payload, signal)
    if (method === 'getUpdates' && result.ok) {
      try {
        write(file, pid, now())
      } catch (err) {
        onWriteError(err)
      }
    }
    return result
  }
}
