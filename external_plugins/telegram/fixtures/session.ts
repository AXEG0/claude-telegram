// The production server with a chat to stream into, an event file for its
// Claude Code process and a folder of subagent transcripts, for the tests of
// the subagents message. Only Telegram's HTTP is fake.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { AGENT_TICK_MS, agentEventFile, appendAgentEvent, type AgentEvent } from '../agents.ts'
import fixture from './channel-argv.json'
import { calls, start, state, until, type Call } from './harness.ts'
import { line } from './transcript.ts'

// Long enough for a tick, the chat's spacing and the fake's answer.
export const WAIT_MS = 2 * AGENT_TICK_MS + 2000

// The owner's message, which makes the owner's chat the one the subagents
// message goes to.
export function ownerWrites(dir: string, text: string): void {
  writeFileSync(join(dir, 'inbound.json'), JSON.stringify([{
    update_id: 1,
    message: { message_id: 1, date: Math.floor(Date.now() / 1000), text,
      from: { id: 1, is_bot: false, first_name: 'Owner' }, chat: { id: 1, type: 'private' } },
  }]))
}

export const isPanel = (c: Call) => (c.method === 'sendMessage' || c.method === 'editMessageText')
  && /^(🤖 Subagents|🐚 Shells)/.test(c.payload.text ?? '')

export async function session(env: Record<string, string> = {}, dir = state()) {
  ownerWrites(dir, 'subagents test')
  const channel = start(dir, fixture.argv, env)
  await channel.ready()
  const file = agentEventFile(dir, channel.child.pid!)
  const base = join(dir, 'transcripts')
  mkdirSync(base, { recursive: true })
  const transcript = (id: string) => join(base, `agent-${id}.jsonl`)
  const panels = () => calls(dir).filter(isPanel)
  return {
    dir, channel, file, base,
    transcript,
    panels,
    // A subagent's start, with its description in its meta file.
    begin(id: string, description: string, t = Date.now(), extra: Partial<AgentEvent> = {}) {
      writeFileSync(join(base, `agent-${id}.meta.json`), JSON.stringify({ description }))
      if (!existsSync(transcript(id))) writeFileSync(transcript(id), '')
      appendAgentEvent(file, { t, event: 'start', agent_id: id, agent_type: 'general-purpose', agent_base: join(base, `agent-${id}`), ...extra })
    },
    write(id: string, ...entries: object[]) {
      appendFileSync(transcript(id), entries.map(line).join(''))
    },
    stop(id: string, t = Date.now(), extra: Partial<AgentEvent> = {}) {
      appendAgentEvent(file, { t, event: 'stop', agent_id: id, ...extra })
    },
    // The first panel send or edit after the first `after` ones that matches.
    async next(match: (text: string) => boolean, after = 0, timeout = WAIT_MS): Promise<Call & { index: number }> {
      let found: (Call & { index: number }) | undefined
      await until(() => {
        const all = panels()
        const i = all.findIndex((c, j) => j >= after && match(c.payload.text))
        if (i >= 0) found = { ...all[i]!, index: i }
        return found !== undefined
      }, timeout)
      return found!
    },
  }
}
export type Session = Awaited<ReturnType<typeof session>>

// A row's line in a panel text, by its number.
export const row = (text: string, n: number) => text.split('\n').find(l => l.startsWith(`${n}. `)) ?? ''
