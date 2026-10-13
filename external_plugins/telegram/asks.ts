// A permission prompt Claude Code relays ("🔐 Permission: Write") goes only to
// the owner chat, TELEGRAM_ALERT_CHAT, and only the owner settles it, with a
// tap on its buttons or a "yes <code>" / "no <code>" reply. Anyone else on the
// allowlist, a person or another bot, neither gets the prompt nor answers it;
// their "yes <code>" reaches Claude as an ordinary message.
//
// The owner chat is the owner's private chat, whose id is the owner's user id,
// a positive number. A group's id is negative and names no one who could
// answer, so with a group there, as with no owner chat, a prompt reaches no
// one on Telegram and is answered in the terminal.
//
// This file carries no dependencies beyond Node's.

// What goes missing without the owner's private chat.
export const NO_ASKS = 'permission prompts are answered only in the terminal'

// The user who gets and answers permission prompts: the owner chat's id when
// it is a private chat's.
export function askOwner(owner: string | undefined): string | undefined {
  return owner !== undefined && /^\d+$/.test(owner) ? owner : undefined
}

// Whether a button tap or a text reply from this sender settles a prompt.
export function ownerAnswers(owner: string | undefined, from: { id: number } | undefined): boolean {
  const asker = askOwner(owner)
  return asker !== undefined && from !== undefined && String(from.id) === asker
}
