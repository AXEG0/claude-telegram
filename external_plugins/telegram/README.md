# Telegram

Connect a Telegram bot to Claude Code. The plugin's MCP server logs into
Telegram as a bot and forwards your messages to the Claude Code session, and
Claude answers through tools to reply, react, edit its messages and fetch
attachments.

This is AXEG0's fork of Anthropic's Telegram plugin. It shows typing for the
whole turn and tells the chat when Claude may be stuck, streams each subagent as
a live message, sends replies as Telegram rich messages, transcribes voice
messages, joins a burst of messages into one, and passes Claude what a message
replies to. It keeps its state in `~/.claude/channels/telegram/`, the same
directory as the official plugin, so a token and pairing carry over. Run one of
the two at a time, as both poll the same bot.

## Prerequisites

- [Bun](https://bun.sh): the MCP server and the plugin's hooks run on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.

## Quick setup

> The default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

**1. Create a bot with BotFather.**

Open a chat with [@BotFather](https://t.me/BotFather) on Telegram and send `/newbot`. BotFather asks for two things:

- **Name**: the display name shown in chat headers (anything, spaces allowed).
- **Username**: a unique handle ending in `bot` (e.g. `my_assistant_bot`). This becomes your bot's link: `t.me/my_assistant_bot`.

BotFather replies with a token that looks like `123456789:AAHfiqksKZ8...`. Copy all of it, including the leading number and colon.

**2. Install the plugin.**

```sh
claude plugin marketplace add AXEG0/claude-telegram
claude plugin install telegram@claude-telegram
```

With the official plugin installed as well, disable it, so that one server polls the bot:

```sh
claude plugin disable telegram@claude-plugins-official
```

**3. Give the server the token.**

In a Claude Code session:

```
/telegram:configure 123456789:AAHfiqksKZ8...
```

This writes `TELEGRAM_BOT_TOKEN=...` to `~/.claude/channels/telegram/.env`. You can also write that file by hand, or set the variable in your shell environment. See [Configuration](#configuration) for the other settings.

**4. Start Claude Code with the channel.**

```sh
claude --dangerously-load-development-channels plugin:telegram@claude-telegram
```

During the channels research preview, `--channels` loads Anthropic's own channel plugins, and a channel plugin from another marketplace loads through `--dangerously-load-development-channels`. Claude Code asks you to confirm the flag at each start.

**5. Pair.**

With Claude Code running from the previous step, DM your bot on Telegram. It replies with a pairing code; a bot that stays silent means the session runs without the flag from step 4. In your Claude Code session:

```
/telegram:access pair <code>
```

Your next DM reaches Claude. Telegram bots accept DMs right away, and pairing looks up your numeric user ID for you.

**6. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist`, so that strangers get no pairing-code replies. Ask Claude to do it, or run `/telegram:access policy allowlist` directly.

## Configuration

The server reads `~/.claude/channels/telegram/.env` when it starts, so a change takes effect after `/reload-plugins` or a session restart. A variable set in the shell environment takes precedence over the file.

| Variable | Effect |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | The bot's token, written by `/telegram:configure`. |
| `TELEGRAM_RICH_MESSAGES` | `true` sends replies and edits as [rich messages](#rich-messages). |
| `TELEGRAM_STT_OPENAI_KEY` | An OpenAI API key, which turns on [speech to text](#voice-messages). |
| `TELEGRAM_STT_MODEL` | The transcription model, `gpt-transcribe` unless set. |
| `TELEGRAM_STT_LANGUAGES` | Languages to pin, comma-separated, such as `en,zh`. |
| `TELEGRAM_ACCESS_MODE` | `static` pins access to `access.json` as it was at start; see [ACCESS.md](./ACCESS.md). |
| `TELEGRAM_STATE_DIR` | The state directory, set in the shell environment. A directory per instance runs several bots on one machine, each with its own token and allowlist. |

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). The default policy is `pairing`. `ackReaction` accepts Telegram's fixed set of reaction emoji.

## Tools exposed to Claude

| Tool | Purpose |
| --- | --- |
| `reply` | Sends to a chat. Takes `chat_id` and `text`, with `reply_to` (a message ID) for native threading and `files` (absolute paths) for attachments. Images (`.jpg`/`.png`/`.gif`/`.webp`) go as photos with an inline preview, other files as documents, up to 50MB each, after the text. `format` picks `rich`, `text` or `markdownv2`; the default is `rich` with rich messages on and `text` otherwise. Long text goes out in several messages. Returns the sent message IDs. |
| `react` | Adds an emoji reaction to a message by ID, from Telegram's fixed set of reaction emoji (👍 👎 ❤ 🔥 👀 and others). |
| `download_attachment` | Downloads an attachment by the `attachment_file_id` on its message to the inbox and returns the local path. Telegram serves bot downloads up to 20MB. |
| `edit_message` | Edits a message the bot sent, for progress updates such as "working…" turning into the result. Takes the same `format` as `reply`. An edit sends no notification, so a finished task gets a new reply. |

## Messages Claude receives

Each message reaches Claude as a `<channel source="telegram" chat_id="…" message_id="…" user="…" ts="…">` tag around its text, with further attributes for what it carries.

### Photos and files

Photos download on arrival to `~/.claude/channels/telegram/inbox/`, and
`image_path` on the tag gives Claude the file to `Read`. Telegram compresses
photos; to pass the original, send it as a file (long-press → Send as File). A
document, video or other file arrives as `attachment_file_id` with its kind,
name, type and size, and Claude fetches it with `download_attachment`.

### Voice messages

With `TELEGRAM_STT_OPENAI_KEY` set, voice notes, audio files and video notes
reach Claude as text. The server downloads the recording to the inbox, sends it
to OpenAI's `/v1/audio/transcriptions`, and delivers the transcript as the
message, marked `[transcript]` after any caption, with `transcribed_by` and
`audio_path` on the tag. `TELEGRAM_STT_LANGUAGES` keeps a short clip from being
heard as a language outside the ones you speak. When transcription fails or
takes longer than 30 seconds, the message arrives as an attachment Claude can
download. The server handles updates in order, so a voice note in transcription
holds the messages after it.

### Bursts

Messages one sender sends in quick succession reach Claude as one, so Claude
answers the burst once rather than its first message alone. Texts join with
line breaks, a long paste that Telegram split into pieces joins back whole, and
photos join their album or the question sent with them. The message carries the
last message's ID, every ID in `message_ids`, the first reply context, and every
photo in `image_paths`, with the first in `image_path`. A batch goes out a
moment after its last message, at once when it is full, and a few seconds after
its first message at the latest. A document, voice note or command sends the
waiting batch first and then goes alone. A message from another sender in the
chat, or one that replies to a different message, sends the waiting batch first
and starts its own.

### Replies and quotes

A message that replies to another carries what it replies to on the tag, as
Telegram sends it: `reply_to_message_id`, `reply_to_user` (`this bot` for the
bot's own messages), `reply_to_text` shortened to 300 characters,
`reply_to_kind` for a photo, voice note or other media, and `reply_quote` for
the part the sender highlighted. A reply to one of the bot's rich messages
carries the text of its blocks.

## What the chat shows

### Typing

Telegram shows "typing…" while Claude's turn runs: from an inbound message, and
for a turn something else started (the terminal, a finished subagent, a
scheduled task) in the private chat that last wrote to the bot. Telegram drops
the indicator after a few seconds or when the bot sends, so the server re-sends
it while the turn runs.

The plugin's hooks mark the session busy on each of Claude's tool calls and
prompts ([hooks/busy.ts](./hooks/busy.ts)) and record the turn's end on `Stop`,
`StopFailure` and `SessionEnd` ([hooks/turn-end.ts](./hooks/turn-end.ts)), under
`turns/` in the state directory. A subagent's tool calls count as activity for
the turn that waits on it, and the subagent's own work shows in its
[own message](#subagents).

The indicator pauses while a permission prompt waits on you and resumes with
the answer. After 30 minutes with neither activity nor a turn end, leaving out
the time a prompt waited, the indicator stops and the bot tells the chat that Claude may be stuck or was
interrupted. An interrupt (Esc) runs no hook, so after one the indicator lasts
until the next turn ends or the 30 minutes pass. A message that arrives while
Claude is busy can land in the next turn.

### Permission prompts

When Claude Code asks permission for a tool call, the bot sends the request to
every allowlisted DM with **See more** for the tool's input and **✅ Allow** /
**❌ Deny** buttons. The answer goes to Claude Code, and the message keeps the
outcome.

### Subagents

Each subagent Claude starts appears in the chat as one message, edited while it
runs, the way the CLI shows it:

```
🤖 general-purpose · Review PRs 3 and 4
⏳ Checking gate mention and server env · 4m 31s · 85.4k tokens
```

It ends as `✅ Done in 6m 10s · 89.8k tokens`. The plugin's `SubagentStart` and
`SubagentStop` hook ([hooks/subagent.ts](./hooks/subagent.ts)) records each
subagent under `agents/` in the state directory, and the server reads the
subagent's transcript for its current step and context size, and its meta file
for its description. A step shows the running tool call's own description, or
the tool with a file name or search pattern (commands, URLs and queries stay on
the machine), then `💭 Thinking…` once the tool returns and `✍️ Writing…` once
the subagent writes its answer.

The messages go, without a notification, to the private chat that last wrote to
the bot since the server started. All subagents in a chat share one edit budget,
a message's clock moves while nothing else changes, and a rate limit holds the
chat for as long as Telegram asks. A subagent whose transcript stays unchanged
for 30 minutes shows as quiet until its stop arrives.

### Rich messages

With `TELEGRAM_RICH_MESSAGES=true`, replies and edits render as Telegram rich
messages: Claude writes GitHub Markdown and Telegram shows native headings,
tables, task lists, quotes, code blocks and collapsible `<details>` sections.
The server parses the Markdown as Telegram reads it, Markdown inside `<details>`
included, and sends it through `sendRichMessage` and `editMessageText`. A `$` in
text goes out escaped, so `$HOME/$USER` stays text rather than a formula, while
code and URLs keep theirs; formulas use `<tg-math>` or a ` ```math ` block. A
tag Telegram would drop, such as the `<String>` in `Vec<String>`, goes out as
text.

A long reply goes out in parts cut between top-level blocks, each within the
size Telegram renders whole. A `<details>` section stays whole, whatever it
holds. A block too big for one part is cut where Markdown allows it: a code
block is closed and reopened, a table repeats its header, and a list or quote is
cut between its items. Any other block that big, and any part Telegram rejects,
goes out plain as written. The parsing runs in a worker, so the bot keeps
polling meanwhile, and text the worker has not split within a few seconds goes
out plain. `format: 'text'` or `'markdownv2'` on a call picks those modes
instead. Rich messages are off by default, as some Telegram clients show them as
unsupported.

## No history or search

Telegram's Bot API offers neither message history nor search, so the bot sees
messages as they arrive. When Claude needs earlier context, it asks you to paste
or summarise it. Photos download on arrival for the same reason, and other files
stay fetchable through their `attachment_file_id`.
