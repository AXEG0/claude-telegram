# Telegram

Connect a Telegram bot to Claude Code. The plugin's MCP server logs into
Telegram as a bot and forwards your messages to the Claude Code session, and
Claude answers through tools to reply, react, edit its messages and fetch
attachments.

This is AXEG0's fork of Anthropic's Telegram plugin. It shows typing for the
whole turn, tells you when Claude may be stuck and when it is back, streams concurrent
subagents and background shells in one live message, joins a burst of messages
into one, passes Claude what a message replies to, and passes on the new text
of a message you edit. It lets Claude talk to another bot, and sends you the
live message and alerts that would go to that bot. With rich messages on, it sends replies as Telegram rich
messages, and with an OpenAI key, it transcribes voice messages. It keeps its
state in `~/.claude/channels/telegram/`, the same directory as the official
plugin, so a token and pairing carry over. Run one of the two at a time, as both
poll the same bot.

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

`--channels` loads the channel plugins on Claude Code's approved list, and this plugin loads through `--dangerously-load-development-channels`, which Claude Code asks you to confirm at each start.

**5. Pair.**

With Claude Code running from the previous step, DM your bot on Telegram. It replies with a pairing code. When the bot stays silent, check that the session runs with the flag from step 4 and that the official plugin is disabled. In your Claude Code session:

```
/telegram:access pair <code>
```

Your next DM reaches Claude. Pairing looks up your numeric user ID for you.

**6. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist`, so that strangers get no pairing-code replies. Ask Claude in your terminal session, or run `/telegram:access policy allowlist` directly.

## Configuration

The server reads `.env` in its state directory when it starts, so a change takes effect after `/reload-plugins` or a session restart. The state directory is `~/.claude/channels/telegram/`, or `channels/telegram/` under `CLAUDE_CONFIG_DIR` when that is set, or `TELEGRAM_STATE_DIR`. The file holds one `NAME=value` per line, with the value unquoted. A variable set in the shell environment takes precedence over the file.

| Variable | Effect |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | The bot's token, written by `/telegram:configure`. |
| `TELEGRAM_RICH_MESSAGES` | `true` sends replies and edits as [rich messages](#rich-messages). |
| `TELEGRAM_STT_OPENAI_KEY` | An OpenAI API key, which turns on [speech to text](#voice-messages). |
| `TELEGRAM_STT_MODEL` | The transcription model, `gpt-transcribe` unless set. |
| `TELEGRAM_STT_LANGUAGES` | Languages to pin, comma-separated, such as `en,zh`. |
| `TELEGRAM_STUCK_MINUTES` | Minutes a turn goes without activity before the [stuck notice](#stuck-alerts), `10` unless set. |
| `TELEGRAM_ALERT_CHAT` | The owner's chat ID. It turns on the [idle alert](#stuck-alerts) and receives it, the notices of what the [permission hook](#permission-prompts) allowed, and the notices that would go to [another bot](#other-bots). |
| `TELEGRAM_ALERT_IDLE_MINUTES` | Minutes the session goes without activity before the idle alert, `45` unless set. |
| `TELEGRAM_ACCESS_MODE` | `static` pins access to `access.json` as it was at start; see [ACCESS.md](./ACCESS.md). |
| `TELEGRAM_STATE_DIR` | The state directory, set in the shell environment. A directory per instance runs several bots on one machine, each with its own token and allowlist. |

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). The default policy is `pairing`. `ackReaction` accepts Telegram's fixed set of reaction emoji.

## Other bots

Another bot reaches Claude through this one, and Claude writes back to it, when
both bots have bot-to-bot communication on in BotFather and each is on the
other's allowlist. Its messages arrive like anyone's, with its username in
`user`.

Telegram delivers a message from one bot to another when it names the receiving
bot by `@username`. Sent to the bot's numeric ID before a message by username
has passed between the two, it is accepted and never arrives. So `reply` takes
a numeric `chat_id` as for anyone, and sends to a bot by its username, files
included: Claude passes back the `chat_id` of the bot's message, or the numeric
ID of an allowlisted bot that has not written. The server knows a chat is a
bot's from Telegram's `is_bot` on a message from it since the server started.
For any other private chat, it asks Telegram once with `getChatMember`, and a
reply fails when Telegram gives no answer. `react` and `edit_message` keep the
numeric ID.

When the private chat that last wrote is a bot's, the [subagent
message](#subagents-and-shells), the [stuck notice](#stuck-alerts) and "Back to
normal" go to `TELEGRAM_ALERT_CHAT` instead, and nowhere when it is unset. The
notices of what the [permission hook](#permission-prompts) allowed go only to
`TELEGRAM_ALERT_CHAT` in any case. A permission prompt still goes to every
allowlisted DM, a bot's included, and the typing indicator still goes to the
bot's chat.

## Tools exposed to Claude

| Tool | Purpose |
| --- | --- |
| `reply` | Sends to a chat, and to [another bot](#other-bots) by its `@username`. Takes `chat_id` and `text`, with `reply_to` (a message ID) for native threading and `files` (absolute paths) for attachments. Images (`.jpg`/`.jpeg`/`.png`/`.gif`/`.webp`) go as photos with an inline preview, other files as documents, up to 50MB each, after the text. `format` picks `text` or `markdownv2`, and with rich messages on also `rich`, which is then the default. Long text goes out in several messages. Returns the sent message IDs. |
| `react` | Adds an emoji reaction to a message by ID, from Telegram's fixed set of reaction emoji (👍 👎 ❤ 🔥 👀 and others). |
| `download_attachment` | Downloads an attachment by the `attachment_file_id` on its message to the inbox and returns the local path. Telegram serves bot downloads up to 20MB. |
| `edit_message` | Edits a message the bot sent, for progress updates such as "working…" turning into the result. Takes the same `format` as `reply`. An edit stays one message, so longer text goes in a new reply, and an edit sends no notification, so a finished task gets a new reply too. |

## Messages Claude receives

Texts, photos, files, voice and audio, videos, video notes and stickers reach
Claude as a `<channel source="plugin:telegram:telegram" chat_id="…" message_id="…" user="…" user_id="…" ts="…">`
tag around the message's text or caption, with further attributes for what the
message carries.

### Photos and files

Photos download on arrival to the inbox, `inbox/` in the state directory, and
`image_path` on the tag gives Claude the file to `Read`. Telegram compresses
photos; to pass the original, send it as a file (long-press → Send as File).
A document, video, video note or sticker, and a voice note or audio file that
goes untranscribed, arrives with `attachment_file_id` and `attachment_kind`,
plus `attachment_name`, `attachment_mime` and `attachment_size` when Telegram
gives them, and Claude fetches it with `download_attachment`.

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

Texts and photos one sender sends in quick succession reach Claude as one
message, so Claude answers the burst once rather than its first message alone.
Texts join with line breaks, a long paste that Telegram split into pieces joins
back whole, and photos join their album or the question sent with them. The
joined message carries the last message's ID, every ID in `message_ids`, and the
first reply context. Its first photo is in `image_path`, and with several
photos, every photo is in `image_paths`, comma-separated.

A batch goes out a moment after its last message, at once when it reaches its
message limit, and a few seconds after its first message at the latest. A
message that would take it past its size limit starts a new batch. Any other
message (a file, voice note, video, sticker, or a text starting with `/`) sends
the waiting batch first and then goes alone. A message from another sender in
the chat, or one replying to a different message than an earlier reply in the
batch, sends the waiting batch first and starts its own.

### Replies and quotes

A message that replies to another carries what it replies to on the tag:
`reply_to_message_id`, `reply_to_user` (`this bot` for the bot's own messages),
`reply_to_text` on one line and shortened to 300 characters, `reply_to_kind`
for a photo, voice note or other media, and `reply_quote` for the part the
sender highlighted. A reply to one of the bot's rich messages carries the text
of its blocks.

### Edits

When you edit a message you sent, its new text or caption reaches Claude as a
message of its own. The tag carries the message's own `message_id` and
`edited="true"`, and its `ts` is the time of the edit:

```
<channel source="plugin:telegram:telegram" chat_id="1" message_id="10" edited="true" user="owner" user_id="1" ts="2026-10-11T12:05:00.000Z">
deploy to prod
</channel>
```

A caption edit also carries `attachment_kind` (`photo`, `document` and the
other captioned kinds) and no file to fetch, since the file came with the
message. An edited reply carries what it replies to, as a new message does.

An edit passes the same access check as a new message from the same sender in
the same chat, read-only: it never starts pairing or writes `access.json`, and
it never answers a permission prompt. It goes alone, after any burst still
waiting in the chat, so the chat keeps its order. Telegram also reports changes
that are not someone correcting text, such as a live location moving or a
formatting change, so an edit without text or a caption sends nothing, and so
does one whose text is what Claude last got for that message. The server
remembers that text for the last 1000 messages since it started; an edit of a
message outside that memory always goes through.

## What the chat shows

### Typing

Telegram shows "typing…" while Claude's turn runs: from an inbound message, and
for a turn something else started (the terminal, a finished subagent, a
scheduled task) in the private chat that last wrote to the bot since the server
started. Telegram drops the indicator after a few seconds or when the bot sends,
so the server re-sends it while the turn runs.

The plugin's hooks mark the session busy at the start and the end of each of
Claude's tool calls and on each prompt ([hooks/busy.ts](./hooks/busy.ts)), and
record the turn's end on `Stop`,
`StopFailure` and `SessionEnd` ([hooks/turn-end.ts](./hooks/turn-end.ts)), under
`turns/` in the state directory. A subagent's tool calls start no typing, as the
subagent's work shows in its [own message](#subagents-and-shells); they count as activity
for the turn that waits on the subagent.

The indicator pauses while a permission prompt waits on you, and resumes when
you answer in Telegram, or at Claude's next tool call after an answer in the
terminal.
After 10 minutes with neither activity nor a turn end, leaving out the time a
prompt waited, the indicator stops and the bot sends the [stuck
notice](#stuck-alerts). An interrupt (Esc) runs no hook, so after one the
indicator lasts until the next turn ends or the 10 minutes pass. A message that
arrives while Claude is busy can wait for the next turn.

### Stuck alerts

Two alerts tell you that Claude may be stuck, both from the activity the hooks
record: prompts, the start and end of tool calls, a subagent's tool calls, and
turn ends.

- **The stuck notice** goes to the chat that is typing, when its turn shows no
  activity for 10 minutes (`TELEGRAM_STUCK_MINUTES`): "⚠️ No turn end seen in 10
  minutes: Claude may be stuck, or was interrupted. Typing has stopped." A
  foreground tool call that runs longer than that, such as a long command, gets
  it too. A typing chat that is [another bot's](#other-bots) has its notice go
  to `TELEGRAM_ALERT_CHAT` instead.
- **The idle alert** goes to `TELEGRAM_ALERT_CHAT`, when the session shows no
  activity at all for 45 minutes (`TELEGRAM_ALERT_IDLE_MINUTES`), whether or not
  a turn is typing: "⚠️ No activity in this Claude Code session for 45 minutes:
  no prompt, tool call or turn end. It may be stuck." It is off unless that chat
  is set, and runs only in the server that polls the bot. It suits a session
  that runs a turn on a schedule shorter than the idle time, such as a heartbeat
  every 30 minutes; a session that can sit idle longer than that gets the alert
  each time it does. The time counts from the server's start, so a new session
  waits the full time, and leaves out the time a permission prompt waits.

Each alert goes once per silence and once per chat, with Telegram's notification. The first
activity after it sends "✅ Back to normal: Claude is active again." once to each
chat that got an alert. When the session ends, the server ends with it and sends
nothing, so a session that dies needs a check outside the machine.

### Permission prompts

When Claude Code asks permission for a tool call, the bot sends the request to
every allowlisted DM with **See more** for the tool's input and **✅ Allow** /
**❌ Deny** buttons. An answer in Telegram goes to Claude Code, and the message
you tapped keeps the outcome.

A session in bypass mode has already told Claude Code to ask nothing, yet
Claude Code still asks before a Bash command it cannot check, such as a
`bash -c` script it cannot read for removals. In the channel session in that
mode, the plugin's `PermissionRequest` hook answers such an ask itself, and the
bot tells `TELEGRAM_ALERT_CHAT`, the owner's chat, what ran instead of asking:

```
🔓 Allowed · Bash · general-purpose agent
Push job archive to rental and check environment
```

**See more** adds the command. The hook cannot tell Claude Code's checks apart,
so a removal of a home or working folder also runs with only this notice.
Without `TELEGRAM_ALERT_CHAT`, the hook still allows the ask and no one gets
the notice; the server says so in its log when it starts. Any
other mode, a session that is not the channel, any other tool, and a hook that
fails all leave the ask as above.

### Subagents and shells

Subagents and background shells running together share one live message, with
one line each. Each edit carries every row, so a busy agent cannot delay the
others:

```
🤖 Subagents · 🐚 Shells
1. ⏳ general-purpose · Review PRs 3 and 4 · Checking gate · 4m 31s · 85.4k tokens
2. ✅ Done in 1m 12s · Explore · Find retry logic · 41.3k tokens
3. ⏳ shell · Wait for CI · 2m 5s
4. ❌ Failed after 12s (exit 1) · shell · Run the tests
```

An agent's line changes to `✅ Done in …`, or `⏹ Stopped after …` when
interrupted. A shell's line carries the description Claude gave the command,
never the command itself, and its running time. It changes to `✅ Done in …`
when the shell exits with 0, `❌ Failed after … (exit N)` when it exits with
another code, and `⏹ Stopped after …` when it is stopped, by TaskStop or by the
end of the subagent that started it. Finished rows stay visible while the
others run. Once the whole group ends, its final message stays intact and the
next group gets a new one. The header names what the message carries:
`🤖 Subagents`, `🐚 Shells`, or both.
The plugin's `SubagentStart`, `SubagentStop` and
successful `TaskStop` hooks ([hooks/subagent.ts](./hooks/subagent.ts)) record each
subagent under `agents/` in the state directory, and the server reads the
subagent's transcript for its current step and context size, and its meta file
for its description. A step shows the running tool call's own description, or
the tool with a file name or search pattern (commands, URLs and queries stay on
the machine), then `💭 Thinking…` once the tool returns and `✍️ Writing…` once
the subagent writes its answer.

The same hook on `PostToolUse` for Bash records a shell when a Bash call goes to
the background, with the file Claude Code writes the shell's output to. Claude
Code runs no hook when a shell ends; it appends `[exited with code N]` or
`[killed]` to that file instead, and the server reads the end of the file for
that line. A successful `TaskStop` of a shell also ends its row.

The message goes, without a notification, to the private chat that last wrote
to the bot since the server started, or to `TELEGRAM_ALERT_CHAT` when that chat
is [another bot's](#other-bots). Agents stay in the chat where they first
appeared. The stream checks every three seconds and sends at most one update
per chat in that interval. The clocks move while nothing else changes, and a
rate limit holds the chat for as long as Telegram asks. Long rows shorten to
fit Telegram's message limit; a group too large for shortened rows shows a
count of the additional agents, prioritizing new rows and unreported endings
over finished history. An explicit interruption in the subagent's transcript
also ends its row on the next stream tick, even when no stop
hook ran. Inactivity alone never counts as completion: a subagent whose
transcript stays unchanged for 30 minutes shows as quiet until its stop
arrives, for up to two hours. A shell never shows as quiet: it may wait in
silence for as long as it runs, and its output file records every ending.

### Rich messages

With `TELEGRAM_RICH_MESSAGES=true`, replies and edits render as Telegram rich
messages: Claude writes GitHub Markdown and Telegram shows native headings,
tables, task lists, quotes, code blocks and collapsible `<details>` sections.
The server parses the Markdown as Telegram reads it, Markdown inside `<details>`
included, and sends it through `sendRichMessage` and `editMessageText`. A `$` in
text goes out escaped, so `$HOME/$USER` stays text rather than a formula, while
code and URLs keep theirs; formulas go in `<tg-math>`. A tag that is not HTML,
such as the `<String>` in `Vec<String>`, goes out as text.

A long reply goes out in parts cut between top-level blocks, each within the
size and block count Telegram renders whole. A `<details>` section stays in one
part, and one too big for a part goes out plain. A block too big for one part is
cut where Markdown allows it: a code block is closed and reopened, a table
repeats its header, and a list or quote is cut between its items. Any other
block that big, and any part Telegram refuses as invalid, goes out plain as
written, in ordinary messages. The parsing runs in a worker, so the bot keeps
polling meanwhile, and text the worker has not split within a few seconds goes
out plain. `format: 'text'` or `'markdownv2'` on a call picks those modes
instead. Rich messages are off by default, as some Telegram clients show them as
unsupported.

## Polling ownership

Only a server whose nearest Claude Code ancestor has `claude` as its executable
name and `plugin:telegram@claude-telegram` as a separate argument polls the bot.
An ordinary session, `claude -p`, or `claude mcp list` serves outbound tools
without consuming updates or touching `bot.pid`, so it leaves a live channel's
poller in place. A new channel session still replaces the previous holder,
including an orphan left by a crashed session.

The server reads the ancestor tree through `/proc`. If it cannot read the tree,
it logs a warning to stderr and polls as before. On hosts without readable
`/proc`, use a separate `TELEGRAM_STATE_DIR` for probes and ordinary sessions.

## Polling heartbeat

After every completed `getUpdates` long-poll, the server rewrites
`poll-heartbeat.json` in the state directory with its pid and the time in epoch
milliseconds, such as `{"pid":1234,"at":1791544879112}`. An idle poll returns at
least every 30 seconds, so a heartbeat older than a minute or two means polling
has stopped, even while the process lives. A failed poll writes nothing. The
file is for a health check outside the process; the server never reads it.

## No history or search

Telegram's Bot API offers neither message history nor search, so the bot sees
messages as they arrive. When Claude needs earlier context, it asks you to paste
or summarize it. Photos download on arrival, so that Claude can `Read` them at
once, and other files download on request through their `attachment_file_id`.
