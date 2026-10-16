# Telegram — Access & Delivery

A Telegram bot is publicly addressable. Anyone who finds its username can DM it, and without a gate those messages would flow straight into your assistant session. The access model described here decides who gets through.

By default, a DM from an unknown sender triggers **pairing**: the bot replies with a 6-character code and drops the message. You run `/telegram:access pair <code>` from your assistant session to approve them. Once approved, their messages pass through.

All state lives in `~/.claude/channels/telegram/access.json`. The `/telegram:access` skill commands edit this file; the server re-reads it at every inbound message and tool call, so changes take effect without a restart. Set `TELEGRAM_ACCESS_MODE=static` to pin config to what was on disk at boot: a change, a bot added with `bot <id> @username` included, then takes effect after `/reload-plugins` or a session restart, and pairing is unavailable since it requires runtime writes.

Only the owner changes access, in the terminal. The skill refuses a request that arrives through a channel message, such as a Telegram message asking to be allowlisted or to add a bot.

## At a glance

| | |
| --- | --- |
| Default policy | `pairing` |
| Sender ID | Numeric user ID (e.g. `412587349`) |
| Group key | Supergroup ID (negative, `-100…` prefix) |
| `ackReaction` quirk | Fixed whitelist only; non-whitelisted emoji silently do nothing |
| Config file | `~/.claude/channels/telegram/access.json` |

## DM policies

`dmPolicy` controls how DMs from senders not on the allowlist are handled.

| Policy | Behavior |
| --- | --- |
| `pairing` (default) | Reply with a pairing code, drop the message. Approve with `/telegram:access pair <code>`. |
| `allowlist` | Drop silently. No reply. Useful if the bot's username is guessable and pairing replies would attract spam. |
| `disabled` | Drop everything, including allowlisted users and groups. |

```
/telegram:access policy allowlist
```

## User IDs

Telegram identifies users by **numeric IDs** like `412587349`. Usernames are optional and mutable; numeric IDs are permanent. The allowlist stores numeric IDs: `allow`, `bot`, `group add` and `--allow` take only a number without a leading zero, so `allow @somebot` writes nothing, and the outbound tools refuse a `chat_id` that is not numeric. `remove` takes any entry present, so an entry stored before this check can still be removed.

Pairing captures the ID automatically. To find one manually, have the person message [@userinfobot](https://t.me/userinfobot), which replies with their ID. Forwarding any of their messages to @userinfobot also works.

```
/telegram:access allow 412587349
/telegram:access remove 412587349
```

## Groups

Groups are off by default. Opt each one in individually.

```
/telegram:access group add -1001654782309
```

Supergroup IDs are negative numbers with a `-100` prefix, e.g. `-1001654782309`. They're not shown in the Telegram UI. To find one, either add [@RawDataBot](https://t.me/RawDataBot) to the group temporarily (it dumps a JSON blob including the chat ID), or add your bot and run `/telegram:access` to see recent dropped-from groups.

With the default `requireMention: true`, the bot responds only when @mentioned or replied to. Pass `--no-mention` to process every message, or `--allow id1,id2` to restrict which members can trigger it.

```
/telegram:access group add -1001654782309 --no-mention
/telegram:access group add -1001654782309 --allow 412587349,628194073
/telegram:access group rm -1001654782309
```

**Privacy mode.** Telegram bots default to a server-side privacy mode that filters group messages before they reach your code: only @mentions and replies are delivered. This matches the default `requireMention: true`, so it's normally invisible. Using `--no-mention` requires disabling privacy mode as well: message [@BotFather](https://t.me/BotFather), send `/setprivacy`, pick your bot, choose **Disable**. Without that step, Telegram never delivers the messages regardless of local config.

## Other bots

Another bot reaches Claude through this one, and gets Claude's replies, when both bots have bot-to-bot communication on in BotFather. Add it with its numeric ID and its username:

```
/telegram:access bot 7012345 @somebot
```

The ID goes into `allowFrom`, and the username, without the `@`, into `botUsernames`, keyed by the ID. The username is never an identity: the server uses it only to open the first chat with a bot that has never written to this one, a chat Telegram's `getChatMember` by ID answers with "chat not found". Before anything is sent, Telegram must return the allowlisted ID for that username, and describe the chat as a bot; the reply then goes to the username Telegram gives, once that username returns the same ID too. A check that fails sends nothing. `remove <id>` deletes both entries.

The ID must be positive, and the username 5 to 32 letters, digits and underscores ending in `bot` in any case. The server ignores an entry that is not, or whose ID is not in `allowFrom`; `/telegram:access` lists such entries as ignored.

## Mention detection

In groups with `requireMention: true`, any of the following triggers the bot:

- A structured `@botusername` mention
- A reply to one of the bot's messages
- A match against any regex in `mentionPatterns`

```
/telegram:access set mentionPatterns '["^hey claude\\b", "\\bassistant\\b"]'
```

## Delivery

Configure outbound behavior with `/telegram:access set <key> <value>`.

**`ackReaction`** reacts to inbound messages on receipt. Telegram accepts only a **fixed whitelist** of reaction emoji; anything else is silently ignored. The full Bot API list:

> 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡

```
/telegram:access set ackReaction 👀
/telegram:access set ackReaction ""
```

**`replyToMode`** controls threading on chunked replies. When a long response is split, `first` (default) threads only the first chunk under the inbound message; `all` threads every chunk; `off` sends all chunks standalone.

**`textChunkLimit`** sets the split threshold. Telegram rejects messages over 4096 characters.

**`chunkMode`** chooses the split strategy: `length` cuts exactly at the limit; `newline` prefers paragraph boundaries.

## Skill reference

| Command | Effect |
| --- | --- |
| `/telegram:access` | Print current state: policy, allowlist, pending pairings, enabled groups. |
| `/telegram:access pair a4f91c` | Approve pairing code `a4f91c`. Adds the sender to `allowFrom` and sends a confirmation on Telegram. |
| `/telegram:access deny a4f91c` | Discard a pending code. The sender is not notified. |
| `/telegram:access allow 412587349` | Add a user ID directly. Takes a numeric ID only. |
| `/telegram:access bot 7012345 @somebot` | Add [another bot](#other-bots): its ID to `allowFrom` and its username to `botUsernames`. |
| `/telegram:access remove 412587349` | Remove from the allowlist, and the ID's entry in `botUsernames`. |
| `/telegram:access policy allowlist` | Set `dmPolicy`. Values: `pairing`, `allowlist`, `disabled`. |
| `/telegram:access group add -1001654782309` | Enable a group. Flags: `--no-mention` (also requires disabling privacy mode), `--allow id1,id2`. |
| `/telegram:access group rm -1001654782309` | Disable a group. |
| `/telegram:access set ackReaction 👀` | Set a config key: `ackReaction`, `replyToMode`, `textChunkLimit`, `chunkMode`, `mentionPatterns`. |

## Config file

`~/.claude/channels/telegram/access.json`. Absent file is equivalent to `pairing` policy with empty lists, so the first DM triggers pairing.

```jsonc
{
  // Handling for DMs from senders not in allowFrom.
  "dmPolicy": "pairing",

  // Numeric user IDs allowed to DM. Only a list counts: any other value
  // admits nobody.
  "allowFrom": ["412587349", "7012345"],

  // Groups the bot is active in. Empty object = DM-only.
  "groups": {
    "-1001654782309": {
      // true: respond only to @mentions and replies.
      // false also requires disabling privacy mode via BotFather.
      "requireMention": true,
      // Restrict triggers to these senders. Empty or absent = any member
      // (subject to requireMention); a value that is not a list admits nobody.
      "allowFrom": []
    }
  },

  // Another bot's username by its ID, written by /telegram:access bot. Used
  // only to open the first chat with a bot that has never written.
  "botUsernames": { "7012345": "somebot" },

  // Case-insensitive regexes that count as a mention.
  "mentionPatterns": ["^hey claude\\b"],

  // Emoji from Telegram's fixed whitelist. Empty string disables.
  "ackReaction": "👀",

  // Threading on chunked replies: first | all | off
  "replyToMode": "first",

  // Split threshold. Telegram rejects > 4096.
  "textChunkLimit": 4096,

  // length = cut at limit. newline = prefer paragraph boundaries.
  "chunkMode": "newline"
}
```
