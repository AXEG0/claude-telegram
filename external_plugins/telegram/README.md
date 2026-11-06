# Telegram

Connect a Telegram bot to Claude Code. The plugin's MCP server logs into
Telegram as a bot and forwards your messages to the Claude Code session, and
Claude answers through tools to reply, react, edit its messages and fetch
attachments.

This is AXEG0's fork of Anthropic's Telegram plugin. It shows typing for the
whole turn, tells you when Claude may be stuck and when it is back, streams concurrent
subagents and background shells in one live message, joins a burst of messages
into one, passes Claude what a message replies to, and passes on the new text
of a message you edit and your reactions to the bot's messages. It lets Claude
talk to another bot, and sends you the live message and alerts that would go to
that bot. With rich messages on, it sends replies as Telegram rich
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
| `TELEGRAM_ALERT_CHAT` | The owner's chat ID, the owner's own user ID. It turns on the [idle alert](#stuck-alerts) and receives it, the [permission prompts](#permission-prompts), which only the owner answers, the notices of what the permission hook allowed, and the notices that would go to [another bot](#other-bots), the [failure notice](#failed-turns) included. |
| `TELEGRAM_ALERT_IDLE_MINUTES` | Minutes the session goes without activity before the idle alert, `45` unless set. |
| `TELEGRAM_ACCESS_MODE` | `static` pins access to `access.json` as it was at start; see [ACCESS.md](./ACCESS.md). |
| `TELEGRAM_STATE_DIR` | The state directory, set in the shell environment. A directory per instance runs several bots on one machine, each with its own token and allowlist. |

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). The default policy is `pairing`. `ackReaction` accepts Telegram's fixed set of reaction emoji.

## Other bots

Another bot reaches Claude through this one, and Claude writes back to it, when
both bots have bot-to-bot communication on in BotFather and the other bot is on
this one's allowlist. Whom the other bot answers is up to it: another copy of
this plugin answers the bots on its own allowlist, and a bridge that pairs by
code answers a new sender with a pairing code. Its messages arrive like
anyone's, with its username in `user`.

Only the owner adds another bot, in the terminal, with its numeric ID and its
username:

```
/telegram:access bot <id> @username
```

The ID goes on the allowlist, and the username into `botUsernames` in
`access.json` (see [ACCESS.md](./ACCESS.md#other-bots)). Chat IDs are numeric:
the tools refuse a `chat_id` that is not, a username included, and Claude
cannot add a bot itself.

Telegram delivers a message from one bot to another when it names the receiving
bot by `@username`. Sent to the bot's numeric ID before a message by username
has passed between the two, it is accepted and never arrives. So `reply` takes
a numeric `chat_id` as for anyone, and sends to a bot by its username, files
included: Claude passes back the `chat_id` of the bot's message, or the numeric
ID of an allowlisted bot. The server knows a chat is a bot's, with its
username, from Telegram's `is_bot` on a message from it since the server
started. For any other private chat, it asks Telegram with `getChatMember` and
keeps the answer; a lookup that fails is asked again at the next reply or edit.

For a bot that has never written to this one, Telegram answers `getChatMember`
with "chat not found". The server then opens the chat by the username stored
with `bot`, and the username serves only that: the reply goes out only when
Telegram returns the allowlisted ID for that username, then describes the chat
as a bot, and returns the same ID for the username it gives the bot, which the
reply goes to. The [server's log](#server-log) shows `opened chat <id> by @<username>`. A check that
fails sends nothing, and the reply fails with an error that names the IDs
involved and no text Telegram returned. Without a stored username, such a bot
is reached once it has written. With `TELEGRAM_ACCESS_MODE=static`, a bot added
while the server runs is reached after a restart.

After each message of a reply to a bot, text or file, the server compares the
chat Telegram says the message went to with the bot's ID. When the two differ,
nothing more of the reply goes, and the reply fails with the count of messages
sent and the message that went elsewhere. The chat stays a bot's for the
notices below, and the next message to it goes only after Telegram returns the
bot's ID for the username it gives, or a new message from the bot. The server
keeps this in its memory, so a restarted server, or the server of another
session on the same bot, stops at its own first message that goes elsewhere.
`react` and `edit_message` keep the numeric ID.

A reply or an edit to a bot goes as plain text, exactly as Claude wrote it,
whichever listed `format` Claude passes. The receiving plugin hands its session a
message's text, caption or media, and a [rich message](#rich-messages) or
its edit carries none of them. A person's chat keeps the format Claude passes.

A reply with files to a bot sends the files first, every file as a document,
so up to ten go as one album; more go as albums of ten, and a single file left
over goes by itself. The text rides as the first file's caption when it is 1024
characters or fewer. A longer text follows the files in pieces of up to 4096
characters, each cut between two characters that are neither a space nor a line
break, since Telegram trims those from both ends of a message. `textChunkLimit`
and `chunkMode` do not apply to such a reply, and a text that is empty once
trimmed sends no text message. Another copy of this plugin holds a bot's files
for the text that follows them (see [Bursts](#bursts)), so the whole reply
reaches its session as one message, however long the upload took. A reply to a
person or a group sends its text first and then each file, as before.

When the private chat that last wrote is a bot's, the [subagent
message](#subagents-and-shells), the [stuck notice](#stuck-alerts) and "Back to
normal" go to `TELEGRAM_ALERT_CHAT` instead, and nowhere when it is unset. So
does the [failure notice](#failed-turns) of a turn a bot's message started. The
[permission prompts](#permission-prompts) and the notices of what the
permission hook allowed go only to `TELEGRAM_ALERT_CHAT` in any case, and a bot
can answer no prompt. The typing indicator still goes to the bot's chat.

## Tools exposed to Claude

| Tool | Purpose |
| --- | --- |
| `reply` | Sends to a chat, and to [another bot](#other-bots) by its `@username`, as plain text. Takes a numeric `chat_id` and `text`, with `reply_to` (a message ID) for native threading and `files` (absolute paths) for attachments. Images (`.jpg`/`.jpeg`/`.png`/`.gif`/`.webp`) go as photos with an inline preview, other files as documents, up to 50MB each, after the text. To [another bot](#other-bots), the files go first, every one as a document, with the text as the first file's caption or after the files, whatever `textChunkLimit` and `chunkMode` say. `format` picks `text` or `markdownv2`, and with rich messages on also `rich`, which is then the default. Any other `format`, such as `markdown` or `null`, is refused with an error naming it and the formats, and nothing is sent. Long text goes out in several messages. `buttons` puts [answer buttons](#button-presses) under the last message sent, a text part or a file: 1 to 4 rows of 1 to 4 labels, each 1 to 40 characters and distinct across the keyboard, with single spaces between words and none of `"` `<` `>` `[` `]` `;`, control characters, or the invisible and combining characters Telegram would change. Buttons are refused in another bot's chat, in a server that does not poll the bot, and in one whose poll ended in a conflict (409) with no poll completed since. Returns the sent message IDs, and with buttons also the message that carries them. A send Telegram refuses, with a 4xx or a 429 and the wait it asks for, or that never leaves, its connection refused or its host's name not found, says not sent. One Telegram answers with a 5xx, or never answers, says delivery unknown, in a result that is no error: Telegram may still deliver it, even minutes later, so Claude sends it again only if the recipient says it did not arrive, and the plugin never sends it again itself. A reply of several parts that stops names the parts sent with their IDs, the part it stopped at and the parts never tried; when the part whose outcome is unknown carries the buttons, they are kept, and a press on them counts once the message arrives. |
| `react` | Adds an emoji reaction to a message by ID, from Telegram's fixed set of reaction emoji (👍 👎 ❤ 🔥 👀 and others). |
| `download_attachment` | Downloads an attachment by the `attachment_file_id` on its message to the inbox and returns the local path. Telegram serves bot downloads up to 20MB. |
| `edit_message` | Edits a message the bot sent, for progress updates such as "working…" turning into the result. Takes `text`, `buttons`, or both, and the same `format` as `reply`: any other is refused and nothing is edited, an edit of the buttons alone included. With `text`, the edit carries `buttons` in the same call, so a text edit without `buttons` leaves the message without buttons, a shown choice included. With `buttons` alone only the buttons change, under a file too, and an empty list removes them, which works from any server. An edit Telegram answers with "message is not modified" counts as done. An edit Telegram refuses says not edited, and one whose outcome is unknown says so and that repeating the same edit is safe, in a result that is no error: an edit that repeats the message's text, or sets no text, with the buttons the message already carries, unpressed, keeps their keyboard, so either copy carries the same buttons. An edit to other text gets a new keyboard, the same labels included, so a press made under the old text gets the closed notice. An edit stays one message, so longer text goes in a new reply, and an edit sends no notification, so a finished task gets a new reply too. |

## Messages Claude receives

Texts, photos, files, voice and audio, videos, video notes and stickers reach
Claude as a `<channel source="plugin:telegram:telegram" chat_id="…" message_id="…" user="…" user_id="…" ts="…">`
tag around the message's text or caption, with further attributes for what the
message carries.

### Photos and files

Photos download on arrival to the inbox, `inbox/` in the state directory, and
`image_path` on the tag gives Claude the file to `Read`. A photo's download,
like a voice message's, runs beside the server's handling of other updates,
with 300 seconds from the photo's arrival (see
[Voice messages](#voice-messages)), and the reason a download failed goes into
the [record of arrivals](#record-of-arrivals). Telegram compresses
photos; to pass the original, send it as a file (long-press → Send as File).
A document, video, video note or sticker, a voice note or audio file that
goes untranscribed, and a photo that fails to download, arrives with
`attachment_file_id` and `attachment_kind`, plus `attachment_name`,
`attachment_mime` and `attachment_size` when Telegram gives them, and Claude
fetches it with `download_attachment`.

### Voice messages

With `TELEGRAM_STT_OPENAI_KEY` set, voice notes, audio files and video notes
reach Claude as text. The server downloads the recording to the inbox, sends it
to OpenAI's `/v1/audio/transcriptions`, and delivers the transcript as the
message, marked `[transcript]` after any caption, with `transcribed_by` and
`audio_path` on the tag. `TELEGRAM_STT_LANGUAGES` keeps a short clip from being
heard as a language outside the ones you speak.

A message's file work, a photo's download or a recording's download and
transcription, runs beside the server's handling of other updates, so other
chats, reactions and button presses never wait for it. A sender's own messages
and edits still reach Claude in the order they were sent: a text sent after a
slow voice note waits for it. A button press and a typed permission answer
(`yes <code>`) pass a waiting note, so a choice or a prompt never stalls behind
it, and in a group another member's message passes it too. Two notes from one
sender download side by side, so the text after them waits for the slower one.

The file work has 300 seconds from the message's arrival. When transcription
fails or runs out of time, the message arrives as an attachment Claude can
download, with `transcript_error` naming the step and the cause, such as
`download HTTP 404` or `getFile gave no answer within 300 s`, and with
`audio_path` when the recording was saved.

### Bursts

Texts, photos and documents one sender sends in quick succession reach Claude
as one message, so Claude answers the burst once rather than its first message
alone. Texts join with line breaks, a long paste that Telegram split into pieces
joins back whole, and photos and documents join their album or the text sent
with them. The joined message carries the last message's ID, every ID in
`message_ids`, and the first reply context. Its first photo is in `image_path`,
and with several photos, every photo is in `image_paths`, comma-separated. Its
`attachment_*` attributes are its first file's, and with several files, every
file's `attachment_file_id` is in `attachment_file_ids` and every file's name in
`attachment_names`, both comma-separated in message order, with an empty name
where Telegram gives none and `_` for a comma in a name.

A batch goes out a moment after its last message, at once when it reaches its
message limit, and a few seconds after its first message at the latest. A
photo or document from another bot waits 3 seconds, for the text another copy
of this plugin sends right after a reply's files (see [Other bots](#other-bots)).
A message that would take it past its size limit starts a new batch. Any other
message (a voice note, audio file, video, video note, sticker, or a person's
text starting with `/`) sends the waiting batch first and then goes alone; a
bot's text starting with `/` joins like any text. A message from another sender
in the chat, or one replying to a different message than an earlier reply in
the batch, sends the waiting batch first and starts its own.

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
waiting in the chat and after any message of the sender's still being
prepared, such as a voice note in transcription, so the chat keeps its order.
Telegram also reports changes that are not someone correcting text, such as a live location moving or a
formatting change, so an edit without text or a caption sends nothing, and so
does one whose text is what Claude last got for that message. The server
remembers that text for the last 1000 messages since it started; an edit of a
message outside that memory always goes through.

### Reactions

When you add a reaction to a message the bot sent, it reaches Claude at once as
an event of its own, never as text you typed. The tag carries the emoji as
`reaction` and the reacted message's `message_id`, its `ts` is the time of the
reaction, and the content names the message and quotes its opening words:

```
<channel source="plugin:telegram:telegram" chat_id="1" message_id="10" reaction="👍" user="owner" user_id="1" ts="2026-10-11T12:06:00.000Z">
👍 on message 10: "Deploy finished. Merge?"
</channel>
```

Only standard emoji you add count: switching 👍 to 👎 sends 👎, adding ❤ beside
👍 sends ❤, and taking a reaction away sends nothing. Custom-emoji and paid
reactions send nothing. Reactions count in private chats only, from senders on
the allowlist, read-only: anyone else's reaction is dropped with no answer and
no pairing code, and Telegram sends no reactions set by bots.

A reaction on one of your own messages sends nothing, for the last 1000 that
reached Claude since the server started. The server also remembers the opening
words of the last 1000 messages it sent with `reply`, as `edit_message` last
left them; a reaction on a message neither memory holds, such as one sent
before a restart, names it by its number alone.

### Button presses

When you press a button Claude put under a message with `reply` or
`edit_message`, the press reaches Claude once, at once, as an event of its own,
never as text you typed. The tag carries the button's label as `button` and the
message's `message_id`, its `ts` is the time the server got the press, and the
content names the message and quotes its opening words:

```
<channel source="plugin:telegram:telegram" chat_id="1" message_id="10" button="Yes" user="owner" user_id="1" ts="2026-10-21T12:07:00.000Z">
Pressed "Yes" on message 10: "Deploy finished. Merge?"
</channel>
```

The buttons then become one disabled button showing the choice, which does
nothing when tapped, and the message's text, rich content or file stays as it
was. In a group, the first press answers for everyone. A press counts from a
sender the chat admits as it would admit a new message, with no mention needed,
never under `dmPolicy` `disabled` and never from a bot, read-only: it never
starts pairing, writes `access.json`, answers a permission prompt or joins a
burst. It goes alone, after any burst waiting in the chat. A second press, a
press on buttons an edit replaced or removed, and a press on a button written
into a rich message's body deliver nothing, and the presser sees a short notice.

Every server on the state directory, polling or not, shares one record of the
buttons it set, `buttons.json`, and changes it under a lock on `buttons.lock`.
So a press made while a server polls reaches Claude, on a message sent before a
restart or a plugin reload too. The record holds 1000 entries; a press on
buttons older than that gets a notice that the question is closed. A Telegram
call that sets, removes or swaps buttons gives up after 10 seconds, and a tool
call that gave up says its outcome is unknown and that repeating the same edit
is safe, in a result that is no error. Repeated as it was, the edit works
whichever copy lands; with other text or other buttons, a first copy that lands
late shows buttons that answer a press with the closed notice. An edit that never lands leaves the old buttons
on the message, and a press on them gets that notice until a later edit of the
message lands. A press is recorded and handed to Claude before the next poll
confirms it to Telegram; its answer and the swap to the disabled button then
run beside the update loop, so a call Telegram never answers holds up no other
message. A press waiting for the lock holds back that server's other inbound
messages for up to 10 seconds per Telegram call made under it. When Telegram answers the swap to the disabled
button with a 429, the buttons stay live until the next press on them, which
delivers nothing and shows the first choice, or until the polling server next
starts. Telegram's Bot API server keeps an unread press for 150 seconds, so a
press made while no server polls for longer is lost and its buttons stay live.
A press that arrives while the server shuts down gets a notice to press again.

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
`turns/` in the state directory, and, for the [failure notice](#failed-turns),
whether it ended on an error, under `outcomes/`. A `StopFailure` that names a subagent ends only
that subagent's [row](#subagents-and-shells), so typing goes on for the turn
that waits on it. A subagent's tool calls start no typing, as the
subagent's work shows in its [own message](#subagents-and-shells); they count as activity
for the turn that waits on the subagent. Each of these hooks acts only on a
JSON object that names one of its own events exactly and carries a non-empty
text session id, as Claude Code's hook input does. Every shell started inside a
session inherits the session's `CLAUDE_PID`, so either script run there by hand
would mark the session; given nothing on stdin, text, or JSON that names
another event or lacks such a session id, it writes nothing. Given an object of
that shape, built by hand or copied from a real hook, it marks the session as a
real hook would.

The indicator pauses while a permission prompt waits on you, and resumes when
you answer in Telegram, or at Claude's next tool call after an answer in the
terminal.
After 10 minutes with neither activity nor a turn end, leaving out the time a
prompt waited, the indicator stops and the bot sends the [stuck
notice](#stuck-alerts). An interrupt (Esc) runs no hook, so after one the
indicator lasts until the next turn ends or the 10 minutes pass. A message that
arrives while Claude is busy can wait for the next turn. A chat Telegram has
asked to wait gets no indicator until the wait ends ([flood
control](#flood-control)), and it comes back at the next refresh if the turn
still runs.

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
chat that got an alert, unless that chat got a [failure notice](#failed-turns)
meanwhile, which brings its own back to normal. When the session ends, the server ends with it and sends
no alert, so a session that dies needs a check outside the machine.

### Failed turns

When a turn that a Telegram message started ends on an error, such as an API
error from the model's provider, the chat whose message started it gets one
notice:

```
⚠️ Claude's turn ended on an error.
Type: unknown
API Error: 402 Insufficient credits. Add more credits to continue.
You will get a message here when a turn ends without an error.
```

The type is Claude Code's class for the error, such as `rate_limit`,
`server_error`, `invalid_request` for a refusal, or `unknown`, and the third
line is Claude Code's own error text. The turns that fail after it send
nothing more, until a turn ends without an error: that turn sends "✅ Back to
normal: Claude's turns end without an error again." once to each chat told,
always after its notice. A notice for [another bot's](#other-bots) chat goes to
`TELEGRAM_ALERT_CHAT`.

The turn-end hook records each `StopFailure` of the main session, and each
`Stop`, under `outcomes/` in the state directory. The server that polls the bot
reads each record a few seconds later, finds the failed turn in the session
transcript the record names, and tells the chats whose messages started that
turn. So:

- A message that arrived while a turn was running, and that Claude Code took
  into that turn, gets no notice of its own when the turn fails.
- A turn that a scheduled task, a background task's notification or the
  terminal started tells nobody, and neither does a subagent's or a helper
  query's failure.
- When a Claude Code release changes the transcript so the turn's start cannot
  be found, the failure tells nobody, and the reason goes to the [server's
  log](#server-log) and to `failure-run.json` in the state directory.

The notice comes 4 to 8 seconds after the failure, or up to about half a
minute later while Claude Code finishes writing the turn. A notice or back to
normal that Telegram refuses or does not answer goes again as soon as Telegram
allows, unless Telegram refuses that chat for good; when Telegram took a
message but its answer was lost, the chat can get that message twice.
`failure-run.json` keeps the run, the chats told and Telegram's answers, so a
restart loses none of them; a `failure-run.json` that holds no run state, cut
short or edited by hand, is replaced by an empty one, with a line in the [server's log](#server-log). A turn that ends on an API error without running
any hook, which some Claude Code releases do, gets no notice; it ends in the
stuck notice instead.

### Permission prompts

When Claude Code asks permission for a tool call, the bot sends the request to
`TELEGRAM_ALERT_CHAT`, the owner's chat, with **See more** for the tool's input
and **✅ Allow** / **❌ Deny** buttons. Only the owner answers it, with a button
or a `yes <code>` / `no <code>` reply. An answer goes to Claude Code, and the
message tapped keeps the outcome. An answer goes after any burst waiting in the
chat, but never waits for a message of the owner's still being prepared, such
as a voice note in transcription. Anyone else on the allowlist, a person or
[another bot](#other-bots), gets no prompt: a tap of theirs is refused, and
their `yes <code>` reaches Claude as an ordinary message. The answer to a tap
and the edits of the prompt run beside the update loop, the prompt's edits in
the order of the taps, so **See more** then **✅ Allow** leaves the outcome.

The owner chat is the owner's private chat, so its ID is the owner's user ID.
Without `TELEGRAM_ALERT_CHAT`, or with a group's ID there, a prompt reaches no
one on Telegram and waits for an answer in the terminal; the server says so in
its [log](#server-log) when it starts.

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
the notice; the server says so in its [log](#server-log) when it starts. Any
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

An agent's line changes to `✅ Done in …`, `⏹ Stopped after …` when
interrupted, or `❌ Failed after … (rate_limit) · general-purpose · Review the plan · 85.4k tokens`
when its run ends on an API error, with the error's class as Claude Code names
it, such as `rate_limit`, `billing_error` or `model_not_found`, no class when
Claude Code gives none or calls it `unknown`, and the token count of its last
real request. A workflow's subagents show like any other subagent, under the
label the workflow gave each, and stopping the workflow closes the rows of those
still running as `⏹ Stopped after …`. A shell's line carries the description
Claude gave the command, never the command itself, and its running time. It
changes to `✅ Done in …` when the shell exits with 0,
`❌ Failed after … (exit N)` when it exits with another code, and
`⏹ Stopped after …` when it is stopped, by TaskStop or by the end of the
subagent that started it. A finished row leaves the message five
minutes after the message first shows it finished, so finished rows stop
taking room from the rows still running; a quiet subagent dropped after two
hours leaves the same way, while running and quiet rows stay. Every
row keeps the number it joined with: the numbers of rows that left are not
reused, a row that joins later takes the next number the message has not used,
and a subagent resumed after its row left comes back under its old number. Once
the whole group ends, its final message stays intact with the endings of its
last five minutes, and the next group gets a new one. The header names what the
message carries: `🤖 Subagents`, `🐚 Shells`, or both.

Claude Code ends a subagent's run on an API error in two ways: it runs
`StopFailure` with the subagent's id and the error's class, or, for errors
such as a refusal at the context limit, it runs no hook at all and writes an
entry for the error into the subagent's transcript. The row closes as failed on
the first tick after either is read. A row closed from its transcript opens
again when a newer entry shows the run going on, as after the nudge Claude
Code sends following a cut refusal, so its group's message ends only once the
next tick finds the same entry still the newest, and a tail with no whole
entry confirms nothing. A stop hook's ending is final: one that arrives after
the group ended edits that message once more with it, at the chat's next slot,
unless the row has already left the message, and the rest of the message stays
as its last frame showed it. A newer group in that chat keeps its own message,
and a row that went on in a newer message keeps its earlier line in the first.
A subagent resumed after such an ending takes its earlier run's place, in the
chat where it first appeared. A subagent's failure leaves the turn's
[typing](#typing) on.

When the server shuts down, it makes one last edit of the live message: each
row still running reads `🔌 No longer followed after …`, with how long it ran
until then and, for a subagent, its last step and tokens, and every finished
row stays as it was. The server shuts down when its session ends, when the
plugin reloads, and when a running workflow moves to a background session, and
it cannot tell these apart, so the line says only that the row is no longer
followed. The edit keeps the chat's spacing, after any send or edit still on
its way, so the server takes up to 14 seconds to exit.

A server can die before that edit goes out: killed, or with the edit refused,
lost or out of time. So each open message keeps a record under `panels/` in
the state directory, holding the text it should read once its server is gone,
rewritten before each edit; and each server holds a lock file there for as long
as it lives, which the system releases however it dies. The server that polls
the bot checks those locks on each tick, edits each message of a server that is
gone to its stored text at the chat's next slot, and deletes its records, then
its lock file. A message whose server was killed is closed that way once the
next server polls the bot. After a plugin reload, the new server shows the rows
still running in a new message once a chat writes to the bot, for subagents
started in the last 30 minutes.

The plugin's `SubagentStart`, `SubagentStop`,
successful `TaskStop` and `StopFailure` hooks ([hooks/subagent.ts](./hooks/subagent.ts)) record each
subagent under `agents/` in the state directory, and the server reads the
subagent's transcript for its current step and context size, and its meta file
for its description. A workflow's subagent keeps both in the workflow run's
folder, `subagents/workflows/<run id>/` in the session's folder, and the server
finds them there by the subagent's id. A step shows the running tool call's own
description, or the tool with a file name or search pattern (commands, URLs and
queries stay on the machine), then `💭 Thinking…` once the tool returns and
`✍️ Writing…` once the subagent writes its answer.

The same hook on `PostToolUse` for Bash records a shell when a Bash call goes to
the background, with the file Claude Code writes the shell's output to. Claude
Code runs no hook when a shell ends; it appends `[exited with code N]` or
`[killed]` to that file instead, and the server reads the end of the file for
that line. A successful `TaskStop` of a shell also ends its row.

The message goes, without a notification, to the private chat that last wrote
to the bot since the server started, or to `TELEGRAM_ALERT_CHAT` when that chat
is [another bot's](#other-bots). Agents stay in the chat where they first
appeared. The stream checks every three seconds and sends or edits the message
into a chat at most once every 12 seconds: 300 times an hour and 7,200 a day,
below the roughly 10,800 sends and edits into a chat in 24 hours after which
Telegram held two installations' chats for hours. A new step or token count
shows at the next of those slots. The clocks move at least every 12 seconds
while nothing else changes, and a rate limit on any of the plugin's calls in
the chat holds it for as long as Telegram asks
([flood control](#flood-control)). Long rows shorten to
fit Telegram's message limit; a group too large for shortened rows shows a
count of the additional agents, prioritizing new rows and unreported endings
over finished history. An explicit interruption in the subagent's transcript
also ends its row on the next stream tick, even when no stop
hook ran; the interruption Claude Code writes when its own process shuts down
does not. That is how a stopped workflow's rows close: Claude Code runs no stop
hook for the subagents the stop ends, and writes the interruption into each
one's transcript. Inactivity alone never counts as completion: a subagent whose
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
such as the `<String>` in `Vec<String>`, goes out as text. A table on the line
right after a paragraph, which Telegram would show as part of that paragraph,
gets one blank line above it, quote markers included, unless that would take its
part past the part's size or block limit or the table past Telegram's 20 columns
or 16 levels, or the table sits where Telegram's reading was never checked, such
as inside raw HTML or with a picture in a cell; such a table goes out as
written.

A long reply goes out in parts cut between top-level blocks, each within the
size and block count Telegram renders whole. A `<details>` section stays in one
part, and one too big for a part goes out plain. A block too big for one part is
cut where Markdown allows it: a code block is closed and reopened, a table
repeats its header, and a list or quote is cut between its items. Any other
block that big, and any part Telegram refuses as invalid, goes out plain as
written, in ordinary messages. The parsing runs in a worker, so the bot keeps
polling meanwhile, and text the worker has not split within a few seconds goes
out plain. `format: 'text'` or `'markdownv2'` on a call picks those modes
instead. A reply or an edit to [another bot](#other-bots) goes as plain text in
any mode. Rich messages are off by default, as some Telegram clients show them as
unsupported.

## Polling ownership

Only a server whose nearest Claude Code ancestor has `claude` as its executable
name and `plugin:telegram@claude-telegram` as a separate argument polls the bot.
An ordinary session, `claude -p`, or `claude mcp list` serves outbound tools
without consuming updates or touching `bot.pid`, so it leaves a live channel's
poller in place. A new channel session still replaces the previous holder,
including an orphan left by a crashed session.

The server reads the ancestor tree through `/proc`. If it cannot read the tree,
it writes a warning to its [log](#server-log) and polls as before. On hosts without readable
`/proc`, use a separate `TELEGRAM_STATE_DIR` for probes and ordinary sessions.

## Poll deadlines

Each long poll (`getUpdates`) gets its 30-second poll time plus 15 seconds, and
the start-up calls, `getMe` and `deleteWebhook`, 30 seconds. A poll Telegram
has not answered by then is dropped and its connection closed, its answer never
read, and the next poll goes 3 seconds later from the same offset, so no
message is lost or handled twice. Each poll opens a connection of its own and
closes it once answered, so the poll after a dropped one never waits on an idle
connection opened before the stall, which Telegram may have dropped meanwhile;
every other call shares the pooled connections. A start-up call that fails
is tried again at once, then after a wait that doubles from 0.1 seconds up to 20
minutes. Each failed poll writes one line to the [server's log](#server-log), with its error
and how long it took, such as `telegram channel: poll failed after 45.0 s: no
answer within 45 s`, so a stall shows whether Telegram hung or refused; a
conflict (409) has its own line. The server asks Telegram for its own list of
update kinds, the twenty grammY asked for up to version 1.41 and reactions, so a
grammY release that adds kinds changes nothing it receives.

The replies to `/start`, `/help` and `/status`, the pairing reply, and the
answers and edits after a tap run beside the update loop, so a call Telegram
never answers holds up no message. A pairing reply still on its way when the
server restarts is lost, and the sender writes again. Sends from the tools keep
grammY's own limit of 500 seconds.

## Flood control

When Telegram refuses a call with 429 (Too Many Requests), the server writes one
line to its [log](#server-log), whichever call it was: a reply, an edit, a reaction, typing,
the [subagents message](#subagents-and-shells), a command reply, a lookup or a
poll. The line names the call, the chat and how long Telegram asks it to wait,
and when that wait ends:

```
telegram channel: flood control on sendMessage to chat <chat>: 429, retry after 1262 s, held until 09:26:46 UTC (Telegram: Too Many Requests: retry after 1262)
```

A call that names no chat, such as a poll or the answer to a tap, says `to no
chat` and holds nothing, and a 429 without a wait says `no retry_after given`
and holds nothing. A caller that already logs its failure, such as a command
reply, an alert or a failed poll, keeps its own line in the log beside this one.

A 429 with a wait on a call to a chat holds that chat until the wait ends, a
read such as the lookup of [another bot](#other-bots) included. While it is
held, [typing](#typing) and the subagents message send nothing to it, and both
come back on their own once the wait ends: typing at its next refresh if the
turn still runs, the subagents message at its next update with what it shows
then. A longer wait extends the hold, and a shorter one never shortens it.
Another bot's chat is held under its `@username`, the name a reply to it goes
by, and typing there checks both names.

Telegram publishes no limit. Two installations' chats were held for hours,
replies included, after about 10,800 sends and edits into each in 24 hours,
nearly all of them edits of the subagents message, while full days of about
9,000 drew no hold. So the subagents message goes into a chat at most 7,200
times a day ([subagents and shells](#subagents-and-shells)).

Everything else still goes to Telegram during a hold: replies, edits and
reactions, command and pairing replies, the answers to taps, permission prompts
and the plugin's own notices. Each is one call made on Claude's request or on an
event, and Telegram's answer to it is the authority: a refused reply says not
sent, with the wait Telegram asks for. Nothing is sent again or queued. The
holds live in the server's memory, so a restart forgets them; the first typing
and subagents call after it then meets Telegram's wait once more, writes its
line and holds the chat again.

### The call record

Every Bot API call the server makes, except its polls, also writes one line to
`logs/calls-<pid>.jsonl` in the state directory, beside the
[server log](#server-log): replies, edits, reactions, typing, the subagents
message, the stuck and idle notices, permission prompts and notices, the
answers to taps, button changes, `getFile` and the start-up calls, whether
Telegram accepted them, refused them or never answered. Every server on the
state directory writes its own file, a send-only one in another session
included, and each line is appended synchronously when the answer comes or the
call fails, so the record answers what the bot sent before a block:

```
{"at":"2026-11-02T09:05:44.000Z","pid":1234,"version":"0.0.7-axeg0.34","call":"sendRichMessage","chat":"<chat>","ms":230,"ok":false,"error_code":429,"retry_after":1262}
```

| Field | What |
| --- | --- |
| `at`, `pid`, `version` | When the answer came or the call failed, in UTC; the server process; the plugin version. |
| `call` | The method, such as `editMessageText`. |
| `chat` | The chat the call names, a number or a `@username`; left out for a call that names none, such as `getMe` or the answer to a tap. |
| `ms` | How long the call took; `at` minus `ms` is when it left. |
| `ok` | `true` accepted, `false` refused, `null` no answer. |
| `message_id`, `message_ids` | A send's id from Telegram's answer, and an album's every id in order; for an edit, a reaction or a keyboard change, the id it names. |
| `silent` | `true` for a send without a notification: today only the subagents message's. |
| `error_code`, `retry_after` | On a refusal, Telegram's code, and its wait in seconds when it gives one. |
| `not_modified` | `true` when Telegram refused an edit as unchanged. |
| `error` | With no answer, the error's name, such as `HttpError/ECONNRESET`, `HttpError/AbortError` or `HttpError/Error` for a call past its time limit. |
| `lost` | How many call lines this server failed to write since the last one it wrote. |

No line holds a message's text, a caption, entities, a keyboard, rich-message
markdown, a file's name or contents, Telegram's error description, an error's
message or the bot token. Each field is written only in its shape, a number, a
boolean, a method name, a chat id or `@username`, or an identifier, and a value
out of shape is left out, or reads `unknown` for `call` and the parts of
`error`. The file still shows which chats the bot wrote to and when, so it is
0600 in the owner-only `logs/` folder. A typing line takes about 140 bytes, a
subagents message edit about 160.

A file past 16 MiB moves to `calls-<pid>.jsonl.1`, replacing the one there, so
a server keeps at most about 32 MiB: at least about four days at the fastest
steady pace, the subagents message every 12 seconds and typing every 4 in one
chat. The turn-end hook's week-old sweep of `logs/` deletes call files too. A
line that cannot be written is dropped and counted in the next line's `lost`;
the call, its hold and every log line go on as before.

Not in the record: the polls, whose latest accepted one the
[heartbeat](#polling-heartbeat) keeps and whose failures write their lines to
the log; the file downloads after `getFile`, which are no Bot API calls; calls
another program, another machine or another state directory makes with the
same token; and a call still under way when a server is forced to exit.

To read the day before a block, run `calls.ts` on the bot's machine, or ask a
session there to:

```
bun "$(ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/telegram/*/calls.ts | sort -V | tail -n 1)"
```

It reads the state directory the server uses, or the one `--state <folder>`
names, merges every server's files and their `.1` by time, and lists every hold:
a chain of 429s with a wait in one chat. It picks the latest hold whose longest
wait ran past 5 minutes, or else the latest, and prints the 24 hours before its
first refusal in that chat: calls per kind, accepted, refused by code
(Telegram's not-modified answers apart) and with no answer, the subagents
message's edits apart from other edits, totals for other chats and for calls
naming none, calls per UTC hour, and the last 20 calls. `--chat <id or @name>`,
given once or more, reads those chats; `--to <UTC time>` ends the window there,
as `2026-11-02 21:00` or `2026-11-02T21:00:00Z`, a time with no zone being
UTC; `--hours <n>` sets the window's length. It warns when rotation has cut a
server's lines out of the window, and counts a line it could not parse and
lists a file it could not read. It reads only, and prints to stdout:

```
state folder: <path>
  calls-1234.jsonl: 2772 lines, 2026-11-02T06:50:02.000Z to 2026-11-02T09:06:30.000Z
  lines skipped: 0; lines lost: 0
holds:
  chat <chat>: from 2026-11-02T09:05:44.000Z to 2026-11-02T09:26:46Z, longest wait 1262 s, 2 refusals
block: chat <chat>, first refusal 2026-11-02T09:05:44.000Z (sendRichMessage, wait 1262 s, ends 2026-11-02T09:26:46Z), lifts 2026-11-02T09:26:46Z
window: 2026-11-01T09:05:44Z to 2026-11-02T09:05:44Z, chat <chat>
per call: accepted, refused by code, no answer
  editMessageText (list): 1404 accepted, 174 400 not modified, 0 no answer
  sendChatAction: 1185 accepted, 0 refused, 0 no answer
  sendMessage: 2 accepted, 0 refused, 0 no answer
  sendRichMessage: 2 accepted, 0 refused, 0 no answer
  other chats: 0 calls, 0 accepted, 0 refused, 0 no answer
  no chat: 3 calls, 3 accepted, 0 refused, 0 no answer
per UTC hour:
  2026-11-02T07:00Z: sendChatAction 375, sendMessage 1, editMessageText (list) 499, sendRichMessage 1
  2026-11-02T08:00Z: sendChatAction 750, sendMessage 1, editMessageText (list) 999
  2026-11-02T09:00Z: sendChatAction 60, editMessageText (list) 80, sendRichMessage 1
first call in the window: 2026-11-02T07:05:00.120Z sendChatAction
last calls before the end:
  2026-11-02T09:03:28.120Z sendChatAction ok
  2026-11-02T09:03:29.000Z editMessageText (list) ok
  ...
  2026-11-02T09:03:59.000Z editMessageText (list) ok
  2026-11-02T09:04:00.000Z sendRichMessage ok
```

The subagents message's edits are those of a message its silent send got, by
chat and id, while that send is still in the files; an edit of a message an
earlier server sent counts under other edits. Another bot's chat can appear
under its number and its `@username`; give both with `--chat` to read them
together.

## Polling heartbeat

After every completed `getUpdates` long-poll, the server rewrites
`poll-heartbeat.json` in the state directory with its pid and the time in epoch
milliseconds, such as `{"pid":1234,"at":1791544879112}`. An idle poll returns at
least every 30 seconds, so a heartbeat that stops advancing for a minute or two
while the process lives means polling has stopped or the server is losing a
conflict (409) to another poller holding the same bot token. The server never
gives up on a conflict: after each one it waits a second longer, up to 15
seconds, so it hears the chat again within 15 seconds of the other poller
stopping. A failed poll writes nothing. The file is for a health check outside
the process; the server never reads it.

## Record of arrivals

`arrivals.jsonl` in the state directory keeps every message the server admits
until it has reached Claude. Before Telegram counts a message delivered, the
server writes a line with its raw update; once Claude Code has taken the
message, a second line with each step's time in milliseconds (`queued`,
`getFile`, `download`, `transcribe`, `batched` and `total`) and the outcome
(`transcribed`, `untranscribed`, `photo saved`, `photo missing`, `delivered`)
or the reason. The file survives restarts, so the reason a voice note went
untranscribed stays readable afterwards.

When the polling server starts, it hands every message whose newest line is
still the first, and which is under 24 hours old, the time Telegram keeps an
update, back through the access check and its sender's order, so a message a
crash, a restart or a shutdown cut off still reaches the next session, a voice
note transcribed. An older one gets a second line saying why it was not
replayed. A message Telegram sends again that the file already holds from the
last 24 hours is skipped. After a rare crash a message can arrive twice; it is
never lost. Once the file passes 1 MiB, it is copied to `arrivals.jsonl.1`, and
the file keeps only the messages still on their way; the next copy waits until
the file has grown by another 1 MiB. The file holds the messages' text, under
the state directory's owner-only permissions. A failure to read or write it
goes to the [server's log](#server-log), and the message carries on to Claude.

## Server log

Claude Code keeps what a plugin's server prints to stderr only until the server
has connected. So the server also writes every line it prints to its own file,
`logs/server-<pid>.jsonl` in the state directory, one file per server process,
before and after it connects. Each line there is one JSON record with the time,
the server's pid, the plugin's version and the text in `log`; a text of several
lines stays one record:

```
{"at":"2026-11-03T13:28:33.120Z","pid":1234,"version":"0.0.7-axeg0.33","log":"telegram channel: shutting down"}
```

The file holds the plugin's own lines, the errors and warnings its libraries
print with `console.error` and `console.warn`, and Bun's process warnings. The
server prints each warning once, as Bun 1.4 prints it with `--trace-warnings`:
its code, its message, where it came from and its detail. The plugin prints
every warning that reaches it, so `NODE_NO_WARNINGS`, `--no-warnings`,
`--disable-warning` and `NODE_REDIRECT_WARNINGS` do not apply to it. An error
passed to the console prints as its name, message and frames, never its own
fields, so the message a failed send carried stays out.

Before a line is written anywhere, the bot token, `TELEGRAM_STT_OPENAI_KEY` and
any text shaped like a bot token read `<masked>`, in the file and on stderr
alike. The lines still carry chat and message IDs, usernames and Telegram's
error texts, which can quote part of a message, so the folder is owner-only
(0700) and each file 0600.

A file past 1 MiB moves to `server-<pid>.jsonl.1`, replacing the one there, so
a server keeps about 2 MiB. The turn-end hook deletes log files untouched for a
week, as it does under `turns/` and `outcomes/`. A line that cannot be written
to the file still goes to stderr, and the server carries on as before. Once
stderr's far end has gone, as when Claude Code exits first, lines still land in
the file, `shutting down` among them. Before the state directory exists, as when
no token was ever set, a line goes to stderr only; Claude Code keeps it, since the
server then exits before it connects.

Beside it, `logs/calls-<pid>.jsonl` holds the [call record](#the-call-record):
a line for each Bot API call the server makes, except its polls, and never on
stderr.

The file does not hold Bun's own output for a crash before the log starts or a
runtime panic, `bun install`'s output at start, which Claude Code keeps, or what
the [rich messages](#rich-messages) parser's worker thread prints, which today
is nothing.

## No history or search

Telegram's Bot API offers neither message history nor search, so the bot sees
messages as they arrive. When Claude needs earlier context, it asks you to paste
or summarize it. Photos download on arrival, so that Claude can `Read` them at
once, and other files download on request through their `attachment_file_id`.

## Tests

Run the suite with `bun run test` in this folder; it runs four test files at a
time. The tests that wait on the server's timers run it on a clock the test
moves forward (`fixtures/clock.ts`), so a 10-second limit or the 1-to-15-second
conflict backoff takes a fraction of a second. Within one server, each timer
fires at its own due time and in its order, and the work it starts runs before
the next timer when that work ends within three turns of the event loop; longer
work, such as a read through `fs/promises`, can land after a later timer of the
same move. The test moves every server 100 ms at a time, so it sees what
happened at most one move late, and it moves the clock only while no process of
the test is working. Such a test waits through the harness (`until`, `wait`, a
request), which holds each limit both on that clock and in real time. The
plugin's own code is the same in tests as in use.

The "Telegram plugin tests" CI job runs the same command and prints the
runner's processors and the suite's time on every run. A run that takes 3
minutes or more fails it, as does any failing test.
