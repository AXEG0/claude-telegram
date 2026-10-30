// Only the Claude Code session that loaded this plugin as a channel may
// consume updates. MCP probes and ordinary sessions still serve outbound tools.

import { readFileSync } from 'fs'
import { basename, join } from 'path'

export const CHANNEL_ENTRY = 'plugin:telegram@claude-telegram'

// The update kinds the polling server asks Telegram for, named here rather
// than taken from grammY's default list, which grows with grammY: the twenty
// kinds that list held up to grammY 1.41, and reactions, which Telegram sends
// only to a bot that asks for them.
export const UPDATE_KINDS = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
  'inline_query',
  'chosen_inline_result',
  'callback_query',
  'shipping_query',
  'pre_checkout_query',
  'purchased_paid_media',
  'poll',
  'poll_answer',
  'my_chat_member',
  'chat_join_request',
  'chat_boost',
  'removed_chat_boost',
  'message_reaction',
] as const

export type ChannelMode = { poll: boolean; warning?: string }

export function channelMode(start: number = process.ppid, proc: string = '/proc'): ChannelMode {
  const seen = new Set<number>()
  let pid = start
  try {
    while (pid > 1) {
      if (seen.has(pid) || seen.size >= 64) throw new Error('invalid ancestor chain')
      seen.add(pid)
      const argv = readFileSync(join(proc, String(pid), 'cmdline'), 'utf8').split('\0').filter(Boolean)
      // Stop at our nearest Claude ancestor. A nested `claude -p` must not
      // inherit channel mode from the interactive session that launched it.
      if (argv[0] && basename(argv[0]) === 'claude') {
        return { poll: argv.slice(1).includes(CHANNEL_ENTRY) }
      }
      // comm is parenthesised and can itself contain spaces or parentheses.
      const stat = readFileSync(join(proc, String(pid), 'stat'), 'utf8')
      const parent = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[1])
      if (!stat.includes(')') || !Number.isSafeInteger(parent) || parent < 0) {
        throw new Error(`invalid parent for pid=${pid}`)
      }
      pid = parent
    }
    return { poll: false }
  } catch (err) {
    // Preserve polling on hosts where /proc is unavailable or unreadable.
    // Make the uncertainty explicit rather than silently disabling a channel.
    return {
      poll: true,
      warning: `telegram channel: WARNING: cannot read Claude ancestor process tree; polling as before: ${err}\n`,
    }
  }
}
