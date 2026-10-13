// Tells the owner when the Claude Code session may be stuck, and when it is
// back. Two clocks run on the same activity: the session's prompts, tool calls
// (their start and their end), subagent tool calls and turn ends, as the
// plugin's hooks record them (see typing.ts).
//
// - The stuck notice: a turn that types into a chat and shows no activity for
//   TELEGRAM_STUCK_MINUTES (10 unless set). It goes to that chat, or to the
//   owner chat when that chat is another bot's (see bots.ts).
// - The idle backstop: no activity at all for TELEGRAM_ALERT_IDLE_MINUTES (45
//   unless set), whether or not a turn types. It catches a session that hangs
//   with no message waiting, so it suits a session that runs a turn on a
//   schedule, such as a heartbeat every 30 minutes. It runs only with an owner
//   chat, only in the server that polls, and goes to the owner chat.
//
// TELEGRAM_ALERT_CHAT names the owner chat. Activity after either notice
// sends one "back to normal" message to each chat that got one.
//
// This file carries no dependencies beyond Node's, like typing.ts.

import { CAP_MS, PROMPT_GRACE_MS } from './typing.ts'

export const STUCK_MINUTES = CAP_MS / 60_000
export const IDLE_MINUTES = 45

// What goes missing without an owner chat.
export const NO_OWNER = 'the idle alert is off, and the notices of what the permission hook allowed and of a bot\'s turn go nowhere'

export type AlertConfig = {
  capMs: number
  // The owner's chat, from TELEGRAM_ALERT_CHAT: the idle alert, the notices
  // of what the permission hook allowed (see permit.ts), and a bot's notices.
  owner?: string
  idleMs: number
  warnings: string[]
}

export function alertConfig(env: NodeJS.ProcessEnv = process.env): AlertConfig {
  const warnings: string[] = []
  const minutes = (name: string, fallback: number): number => {
    const raw = env[name]?.trim()
    if (!raw) return fallback
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return n
    warnings.push(`telegram channel: ${name}=${raw} is not a positive number of minutes; using ${fallback}\n`)
    return fallback
  }
  const capMs = minutes('TELEGRAM_STUCK_MINUTES', STUCK_MINUTES) * 60_000
  const chat = env.TELEGRAM_ALERT_CHAT?.trim()
  if (!chat) return { capMs, idleMs: IDLE_MINUTES * 60_000, warnings }
  if (!/^-?\d+$/.test(chat)) {
    warnings.push(`telegram channel: TELEGRAM_ALERT_CHAT=${chat} is not a chat id; ${NO_OWNER}\n`)
    return { capMs, idleMs: IDLE_MINUTES * 60_000, warnings }
  }
  return { capMs, owner: chat, idleMs: minutes('TELEGRAM_ALERT_IDLE_MINUTES', IDLE_MINUTES) * 60_000, warnings }
}

export function duration(ms: number): string {
  if (ms < 60_000) {
    const s = Math.max(1, Math.round(ms / 1000))
    return s === 1 ? '1 second' : `${s} seconds`
  }
  const m = Math.round(ms / 60_000)
  return m === 1 ? '1 minute' : `${m} minutes`
}

export const stuckText = (capMs: number) =>
  `⚠️ No turn end seen in ${duration(capMs)}: Claude may be stuck, or was interrupted. Typing has stopped.`

export const idleText = (idleMs: number) =>
  `⚠️ No activity in this Claude Code session for ${duration(idleMs)}: no prompt, tool call or turn end. It may be stuck.`

export const RECOVERED_TEXT = '✅ Back to normal: Claude is active again.'

export type IdleAlarm = {
  tick(): void
  pause(): void
  resume(): void
}

export function createIdleAlarm(opts: {
  // The last activity the hooks recorded: tool calls, prompts, subagent tool
  // calls and turn ends.
  activityAt: () => number
  idleMs: number
  onIdle: () => void
  onRecover: () => void
  now?: () => number
}): IdleAlarm {
  const now = opts.now ?? Date.now
  // The server's start counts as activity, so a fresh session never alerts at once.
  let since = now()
  let alertedAt = 0
  let pausedAt = 0

  return {
    tick() {
      const activity = Math.max(opts.activityAt(), since)
      if (alertedAt) {
        if (activity > alertedAt) {
          alertedAt = 0
          opts.onRecover()
        }
        return
      }
      // A permission prompt waits on the owner. Claude's own activity past the
      // grace shows it was answered in the terminal, as in typing.ts.
      if (pausedAt) {
        if (activity <= pausedAt + PROMPT_GRACE_MS) return
        pausedAt = 0
      }
      const t = now()
      if (t - activity >= opts.idleMs) {
        alertedAt = t
        opts.onIdle()
      }
    },
    pause() {
      if (!pausedAt) pausedAt = now()
    },
    // An answer in Telegram: the clock restarts from it.
    resume() {
      if (!pausedAt) return
      pausedAt = 0
      since = Math.max(since, now())
    },
  }
}
