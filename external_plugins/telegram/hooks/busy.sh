#!/bin/sh
# PreToolUse and UserPromptSubmit hook: marks this Claude Code process busy,
# so the Telegram server types while a turn runs, whoever started it. See
# typing.ts. Plain sh, since it runs on every tool call. A subagent's tool
# calls carry agent_id and do not count: subagents have their own messages.
input=$(cat)
case "$input" in *'"agent_id"'*) exit 0 ;; esac
[ -n "$CLAUDE_PID" ] || exit 0
dir="${TELEGRAM_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/telegram}/turns"
mkdir -p "$dir" 2>/dev/null && : > "$dir/busy-$CLAUDE_PID" 2>/dev/null
exit 0
