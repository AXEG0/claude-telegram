# Telegram

Connect a Telegram bot to your Claude Code with an MCP server.

The MCP server logs into Telegram as a bot and provides tools to Claude to reply, react, or edit messages. When you message the bot, the server forwards the message to your Claude Code session.

> This is AXEG0's fork of Anthropic's official Telegram plugin. It adds a typing
> indicator that lasts the whole turn, speech to text for voice messages, and a
> live message per subagent. Install it from this repo's marketplace and
> start Claude Code with the development flag, since only Anthropic's own channel
> plugins pass `--channels` during the research preview:
>
> ```
> /plugin marketplace add AXEG0/claude-telegram
> /plugin install telegram@claude-telegram
> claude --dangerously-load-development-channels plugin:telegram@claude-telegram
> ```
>
> It shares `~/.claude/channels/telegram/` with the official plugin, so the token
> and pairing carry over. Enable one of the two at a time: both poll the same bot.

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.

## Quick Setup
> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

**1. Create a bot with BotFather.**

Open a chat with [@BotFather](https://t.me/BotFather) on Telegram and send `/newbot`. BotFather asks for two things:

- **Name** — the display name shown in chat headers (anything, can contain spaces)
- **Username** — a unique handle ending in `bot` (e.g. `my_assistant_bot`). This becomes your bot's link: `t.me/my_assistant_bot`.

BotFather replies with a token that looks like `123456789:AAHfiqksKZ8...` — that's the whole token, copy it including the leading number and colon.

**2. Install the plugin.**

These are Claude Code commands — run `claude` to start a session first.

Install the plugin:
```
/plugin install telegram@claude-plugins-official
```

**3. Give the server the token.**

```
/telegram:configure 123456789:AAHfiqksKZ8...
```

Writes `TELEGRAM_BOT_TOKEN=...` to `~/.claude/channels/telegram/.env`. You can also write that file by hand, or set the variable in your shell environment — shell takes precedence.

> To run multiple bots on one machine (different tokens, separate allowlists), point `TELEGRAM_STATE_DIR` at a different directory per instance.

**4. Relaunch with the channel flag.**

The server won't connect without this — exit your session and start a new one:

```sh
claude --channels plugin:telegram@claude-plugins-official
```

**5. Pair.**

With Claude Code running from the previous step, DM your bot on Telegram — it replies with a 6-character pairing code. If the bot doesn't respond, make sure your session is running with `--channels`. In your Claude Code session:

```
/telegram:access pair <code>
```

Your next DM reaches the assistant.

> Unlike Discord, there's no server invite step — Telegram bots accept DMs immediately. Pairing handles the user-ID lookup so you never touch numeric IDs.

**6. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies. Ask Claude to do it, or `/telegram:access policy allowlist` directly.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). Default policy is `pairing`. `ackReaction` only accepts Telegram's fixed emoji whitelist.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments. Images (`.jpg`/`.png`/`.gif`/`.webp`) send as photos with inline preview; other types send as documents. Max 50MB each. Auto-chunks text; files send as separate messages after the text. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to a message by ID. **Only Telegram's fixed whitelist** is accepted (👍 👎 ❤ 🔥 👀 etc). |
| `edit_message` | Edit a message the bot previously sent. Useful for "working…" → result progress updates. Only works on the bot's own messages. |

Inbound messages start a typing indicator that lasts until Claude's turn ends.
Telegram drops the indicator after a few seconds or when the bot sends, so the
server re-sends it while the turn runs. The plugin's `Stop`, `StopFailure` and
`SessionEnd` hook ([hooks/turn-end.ts](./hooks/turn-end.ts)) records the turn end
under `~/.claude/channels/telegram/turns/`, which stops it. The indicator holds
while a permission prompt waits on you, and that wait does not count toward its
30 minutes. After 30 minutes without a turn end it stops, and the bot tells the
chat that Claude may be stuck or was interrupted. An interrupt (Esc)
runs no hook, so after one the indicator lasts until the next turn ends or the
30 minutes pass. A message that arrives while Claude is busy can land in the
next turn, which then shows no indicator.

## Photos

Inbound photos are downloaded to `~/.claude/channels/telegram/inbox/` and the
local path is included in the `<channel>` notification so the assistant can
`Read` it. Telegram compresses photos — if you need the original file, send it
as a document instead (long-press → Send as File).

## Subagents

Each subagent Claude starts appears in the chat as one message that is edited
while it runs, the way the CLI shows it:

```
🤖 general-purpose · Review PRs 3 and 4
⏳ Checking gate mention and server env · 4m 31s · 85.4k tokens
```

and ends as `✅ Done in 6m 10s · 89.8k tokens`. The plugin's `SubagentStart` and
`SubagentStop` hook ([hooks/subagent.ts](./hooks/subagent.ts)) records each
subagent under `~/.claude/channels/telegram/agents/`, and the server reads the
subagent's own transcript for its current step and context size, and its meta
file for its description. Messages go to the private chat that last wrote to the
bot, without a notification, and only once someone has written since the server
started.

## Voice messages

With `TELEGRAM_STT_OPENAI_KEY` set in `~/.claude/channels/telegram/.env`, voice
notes, audio files and video notes reach Claude as text. The server downloads the
file to the inbox, sends it to OpenAI's `/v1/audio/transcriptions` with
`gpt-transcribe`, and delivers the transcript as the message, marked
`[transcript]` after any caption, with `transcribed_by` and `audio_path` on the
`<channel>` tag. `TELEGRAM_STT_MODEL`
picks another model, and `TELEGRAM_STT_LANGUAGES` pins languages, comma-separated
(`en,zh`), which keeps a short clip from being heard as a third language. When
transcription fails or takes longer than 30 seconds, the message arrives as it
does without a key, as an attachment Claude can download. Updates are handled one
at a time, so a voice note can hold later messages for up to those 30 seconds.

## No history or search

Telegram's Bot API exposes **neither** message history nor search. The bot
only sees messages as they arrive — no `fetch_messages` tool exists. If the
assistant needs earlier context, it will ask you to paste or summarize.

This also means there's no `download_attachment` tool for historical messages
— photos are downloaded eagerly on arrival since there's no way to fetch them
later.
