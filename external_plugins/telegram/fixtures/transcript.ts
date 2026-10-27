// Lines of a subagent's transcript in Claude Code 2.1.311's layout, with
// neutral values: user and assistant entries, the assistant entry Claude Code
// writes for an API error (model "<synthetic>", zero usage, isApiErrorMessage
// and the error's class), the interruption marker, and the bookkeeping lines
// it writes between them (attachments and request records).
const iso = (t: number) => new Date(t).toISOString()
const common = (uuid: string, t: number) => ({ parentUuid: null, isSidechain: true, uuid, timestamp: iso(t), userType: 'external', entrypoint: 'cli' })

export const line = (entry: object) => JSON.stringify(entry) + '\n'

export const userText = (uuid: string, t: number, text: string) =>
  ({ ...common(uuid, t), type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })

export const toolCall = (uuid: string, t: number, description: string, tokens: number) =>
  ({ ...common(uuid, t), type: 'assistant', message: { role: 'assistant', model: 'claude-test', type: 'message',
    content: [{ type: 'tool_use', id: `toolu-${uuid}`, name: 'Bash', input: { command: 'true', description } }],
    usage: { input_tokens: tokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })

export const assistantText = (uuid: string, t: number, text: string) =>
  ({ ...common(uuid, t), type: 'assistant', message: { role: 'assistant', model: 'claude-test', type: 'message',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })

export const apiError = (uuid: string, t: number, error?: string) =>
  ({ ...common(uuid, t), type: 'assistant', message: { id: `msg-${uuid}`, container: null, model: '<synthetic>', role: 'assistant',
    stop_reason: 'stop_sequence', stop_sequence: '', type: 'message',
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    content: [{ type: 'text', text: 'API Error: the request failed' }] },
  ...(error === undefined ? {} : { error }), isApiErrorMessage: true })

export const interruption = (uuid: string, t: number, shutdown = false) =>
  ({ ...userText(uuid, t, '[Request interrupted by user]'), ...(shutdown ? { interruptedByShutdown: true } : {}) })

export const attachment = (uuid: string, t: number) =>
  ({ ...common(uuid, t), type: 'attachment', attachment: { type: 'todo_reminder', content: [] } })

// A request record of about this many bytes.
export const requestBlob = (bytes: number) => ({ type: 'api-request-blob', blob: 'x'.repeat(bytes) })
