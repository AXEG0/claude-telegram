<div align="center">

# Telegram for Claude Code

**Talk to your Claude Code session from Telegram, and watch it work.**

[![Claude Code](https://img.shields.io/badge/Claude_Code-channel_plugin-D97757)](external_plugins/telegram/README.md)
[![Telegram Bot API](https://img.shields.io/badge/Telegram_Bot_API-10.3-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![License](https://img.shields.io/badge/license-Apache_2.0-blue)](LICENSE)

</div>

AXEG0's fork of Anthropic's official Telegram channel plugin. Your bot forwards
messages into the Claude Code session, and Claude replies, reacts and edits
through it.

## ✨ Features

| Feature | What you get |
| --- | --- |
| ⌨️ **Typing for the whole turn** | "typing…" stays on while Claude works, whoever started the turn. |
| 🚨 **Stuck alerts** | The bot tells you when a turn shows no activity for 10 minutes, or, with an alert chat set, the whole session for 45, and again when Claude is back. |
| 🤖 **Live subagents and shells** | Concurrent subagents and background shells share one live message: one row each with step, time and tokens, or a shell's description and time, then Done, Failed with its exit code, or Stopped. A finished row leaves the message five minutes after it first shows finished. |
| 📝 **Rich messages** | Headings, tables, task lists, code and collapsible sections render natively in Telegram. |
| 🎙️ **Voice messages** | Voice notes, audio and video notes reach Claude as text, transcribed by OpenAI. |
| 📦 **Bursts as one message** | Quick texts, a long paste Telegram split, and a photo with its question arrive together, so Claude answers once. |
| ↩️ **Reply context** | Claude sees the message you replied to and the part you quoted. |
| ✏️ **Edits** | Edit a message you sent, and Claude gets its new text as an edit of that message. |
| 👍 **Reactions** | React to a message the bot sent, and Claude gets the emoji at once as your reaction to that message, with its opening words. |
| 🔘 **Answer buttons** | Claude puts buttons under a question, such as Yes and No; your press reaches Claude once, as your choice on that message, and the buttons then show what you picked. |
| 🤝 **Other bots** | Claude talks to another bot that has bot-to-bot communication on, and the live subagent message and stuck alerts that would go to the bot go to you. Chat IDs are numeric: only you add another bot, in the terminal, with `/telegram:access bot <id> @username`, and Claude then reaches it before it has written. |
| 🔐 **Permissions for you alone** | Permission prompts go only to you, and only your tap or `yes <code>` reply answers them. In bypass mode, a Bash ask is allowed with a notice to you instead of a prompt. |

Plus everything from the official plugin: pairing and allowlists, photos and
files, and reactions.

## 👀 In the chat

```
🤖 Subagents · 🐚 Shells
1. ⏳ general-purpose · Review PRs 3 and 4 · Checking gate · 4m 31s · 85.4k tokens
2. ✅ Done in 1m 12s · Explore · Find the retry logic · 41.3k tokens
3. ⏳ shell · Wait for CI · 2m 5s
```

## 🚀 Quick start

```sh
claude plugin marketplace add AXEG0/claude-telegram
claude plugin install telegram@claude-telegram
claude --dangerously-load-development-channels plugin:telegram@claude-telegram
```

Then give the bot its token with `/telegram:configure` and pair your account.
The [setup guide](external_plugins/telegram/README.md#quick-setup) walks
through BotFather, the token and pairing. With the official plugin installed,
disable it first (`claude plugin disable telegram@claude-plugins-official`):
both share the same token and pairing.

Turn on the optional features in `~/.claude/channels/telegram/.env`:

```sh
# Rich messages
TELEGRAM_RICH_MESSAGES=true
# Voice messages as text
TELEGRAM_STT_OPENAI_KEY=sk-...
```

## 📖 Docs

- [Plugin README](external_plugins/telegram/README.md): setup, settings, tools and how each feature behaves.
- [ACCESS.md](external_plugins/telegram/ACCESS.md): DM policies, groups and allowlists.

## About

Forked from [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official).
This marketplace publishes the Telegram plugin; the other directories come from
the upstream repository. Licensed under [Apache 2.0](LICENSE).
