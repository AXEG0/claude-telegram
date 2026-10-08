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
| ⌨️ **Typing for the whole turn** | "typing…" stays on while Claude works, whoever started the turn, and the bot tells you when Claude may be stuck. |
| 🤖 **Live subagents** | Each subagent gets one message, edited as it runs: its step, time and tokens, then Thinking, Writing and Done. |
| 📝 **Rich messages** | Headings, tables, task lists, code and collapsible sections render natively in Telegram. |
| 🎙️ **Voice messages** | Voice notes, audio and video notes reach Claude as text, transcribed by OpenAI. |
| 📦 **Bursts as one message** | Quick texts, a long paste Telegram split, and a photo with its question arrive together, so Claude answers once. |
| ↩️ **Reply context** | Claude sees the message you replied to and the part you quoted. |

Plus everything from the official plugin: pairing and allowlists, photos and
files, reactions, and permission prompts with Allow and Deny buttons.

## 👀 In the chat

```
🤖 general-purpose · Review PRs 3 and 4
⏳ Checking gate mention and server env · 4m 31s · 85.4k tokens

🤖 Explore · Find the retry logic
✅ Done in 1m 12s · 41.3k tokens
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
