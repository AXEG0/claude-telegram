// The production server with owner chat 1, the session transcript its hooks
// name, and the registered Stop and StopFailure hooks run as Claude Code runs
// them, for the tests of the failure notice. Only Telegram's HTTP is fake.
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { failureFiles, failureText, RESTORED_TEXT, type FailureRecord, type RunState } from '../failures.ts'
import { REFRESH_MS } from '../typing.ts'
import fixture from './channel-argv.json'
import { calls, start, state, until, wait } from './harness.ts'
import { runRegistered } from './hooks.ts'
import turnHooks from './turn-hooks.json'
import { append, CREDITS, restamp, type Line } from './turns.ts'

// What must come comes within three ticks: the record waits one, the next
// tick handles it, and a lookup or the transcript can take one more. A
// record is handled within two ticks, so a notice that was to come for it
// has come by NOTHING_MS. One more tick shows nothing else came.
export const COMES_MS = 3 * REFRESH_MS + 2000
export const NOTHING_MS = 2 * REFRESH_MS + 1000
export const QUIET_MS = REFRESH_MS + 1000

export const notice = (said = CREDITS, error = 'unknown') => failureText({ error, text: said })
export { CREDITS, RESTORED_TEXT }

export async function failing(env: Record<string, string> = {}, dir = state()) {
  const channel = start(dir, fixture.argv, { TELEGRAM_ALERT_CHAT: '1', ...env })
  await channel.ready()
  return session(dir, channel)
}

export function session(dir: string, channel: ReturnType<typeof start>) {
  let files = 0
  const env = (pid = channel.child.pid) => ({ TELEGRAM_STATE_DIR: dir, CLAUDE_PID: String(pid) })
  // Every message Telegram took, in order; a refused call is left out.
  const sent = () => calls(dir).filter(c => c.method === 'sendMessage' && !c.refused)
  const s = {
    dir, channel,
    transcript: '',
    // A new transcript for the turns after this, as after /clear.
    next() {
      s.transcript = join(dir, `transcript-${++files}.jsonl`)
      writeFileSync(s.transcript, '', { flag: 'a' })
      return s
    },
    // Recorded lines, moved in time so the line at `index` (counted from 1)
    // is stamped `ago` ms before now.
    recorded(lines: Line[], index: number, ago = 50) { append(s.transcript, restamp(lines, index, Date.now() - ago)) },
    write(...lines: Line[]) { append(s.transcript, lines) },
    fail(said = CREDITS, error = 'unknown', pid?: number) {
      return runRegistered('StopFailure', { ...turnHooks.main_stop_failure_402, transcript_path: s.transcript, error, last_assistant_message: said }, env(pid))
    },
    stop(said: string, pid?: number, sessionId = turnHooks.stop_after_402.session_id) {
      return runRegistered('Stop', { ...turnHooks.stop_after_402, session_id: sessionId, transcript_path: s.transcript, last_assistant_message: said }, env(pid))
    },
    hook(event: string, input: object, pid?: number) { return runRegistered(event, input, env(pid)) },
    sent,
    // failure-run.json as the server last wrote it, and the failure records
    // the hooks wrote for the server's Claude Code process.
    run: () => JSON.parse(readFileSync(join(dir, 'failure-run.json'), 'utf8')) as RunState,
    records: (pid = channel.child.pid) => readFileSync(failureFiles(dir, [pid!])[0]!, 'utf8').trim().split('\n').map(l => JSON.parse(l) as FailureRecord),
    texts: (chat: string) => sent().filter(c => c.payload.chat_id === chat).map(c => c.payload.text as string),
    // The chat's messages once it has taken `count`, or at the timeout; an
    // error reading them ends the test with that error. The check holds the
    // limit itself, so `until` returns at it, and throws only when no server
    // is left to move the test's clock.
    async arrived(chat: string, count: number, timeout = COMES_MS) {
      const end = Date.now() + timeout
      await until(() => s.texts(chat).length >= count || Date.now() >= end, timeout)
      return s.texts(chat)
    },
    // The same, once a tick more has passed.
    async settled(chat: string, count: number, timeout = COMES_MS) {
      await s.arrived(chat, count, timeout)
      await wait(QUIET_MS)
      return s.texts(chat)
    },
  }
  return s.next()
}
export type Failing = ReturnType<typeof session>
