// The stand-in's side of the live check (live-check.ts): every case run
// through the tests' stand-in for Telegram, telegram-preload.ts, as the
// plugin's tests run it, printed as JSON on stdout. Each case sends to a bot
// the stand-in hands what it sends to (TELEGRAM_TEST_BRIDGE), so a send's
// result carries both of the stand-in's answers: what it answered the send,
// and the update it bridged to the receiving bot. It needs no token and
// reaches no host, since the stand-in refuses every fetch.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'live-check-stand-in-'))
const bridgeDir = join(dir, 'bridge')
const PEER = { id: 777, is_bot: true, username: 'live_check_peer' }
process.env.TELEGRAM_TEST_API_LOG = join(dir, 'api.jsonl')
process.env.TELEGRAM_TEST_CHATS = JSON.stringify({ ids: 1 })
process.env.TELEGRAM_TEST_USERS = JSON.stringify({ [PEER.id]: PEER })
process.env.TELEGRAM_TEST_BRIDGE = JSON.stringify({ dir: bridgeDir, username: PEER.username })
try {
  await import('./telegram-preload.ts')
  const { Bot } = await import('grammy')
  const { runCases } = await import('../live-check.ts')
  type Seen = import('../live-check.ts').Seen
  const bot = new Bot('test-bot-token')
  const bridged = new Map<string, Seen>()
  let read = 0
  const outcome = await runCases({
    raw: (method, payload) => (bot.api.raw as any)[method](payload),
    // Sends go to the bot by its username, as the stand-in bridges only
    // those, and edits and deletes by its chat's id, as the plugin makes them.
    sendTo: `@${PEER.username}`,
    editIn: PEER.id,
    pace: 0,
    read: (c, seen) => {
      let names: string[] = []
      try { names = readdirSync(bridgeDir).filter(f => /^\d+\.json$/.test(f)).sort() } catch {}
      const messages = names.slice(read).map(f => JSON.parse(readFileSync(join(bridgeDir, f), 'utf8')).message)
      read = names.length
      if (!c.method.startsWith('send') || 'refused' in seen) return
      bridged.set(c.name, c.method === 'sendMessage' ? { text: messages[0]?.text ?? null }
        : c.method === 'sendMediaGroup' ? { captions: messages.map(m => m.caption ?? null) }
        : { caption: messages[0]?.caption ?? null })
    },
  })
  if (outcome.stopped !== undefined) throw new Error(outcome.stopped)
  console.log(JSON.stringify({ cases: outcome.cases.map(c => ({ ...c, ...(bridged.has(c.name) ? { bridged: bridged.get(c.name) } : {}) })) }))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
