// Speech to text for inbound voice notes, audio files and video notes. The
// server downloads the file to the inbox and sends it to OpenAI's
// /v1/audio/transcriptions, then hands Claude the transcript as the message
// text, with the audio path beside it for a second listen.
//
// Configuration, from the environment or the channel's .env:
//   TELEGRAM_STT_OPENAI_KEY  OpenAI API key; STT is off without it
//   TELEGRAM_STT_MODEL       default gpt-transcribe
//   TELEGRAM_STT_LANGUAGES   optional languages to pin, comma-separated, e.g. en,zh
//
// The key has its own name so an ambient OPENAI_API_KEY meant for something
// else never reaches this call.

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

export const STT_KINDS = new Set(['voice', 'audio', 'video_note'])
// The whole lookup, download and transcription. Updates are handled one at a
// time, so this bounds how long a voice note can hold later messages.
export const STT_TIMEOUT_MS = 30_000
// The Bot API serves files up to this size.
export const STT_MAX_BYTES = 20 * 1024 * 1024

export type SttConfig = {
  apiKey: string
  model: string
  languages?: string
  endpoint: string
}

export function sttConfig(env: NodeJS.ProcessEnv = process.env): SttConfig | undefined {
  const apiKey = env.TELEGRAM_STT_OPENAI_KEY?.trim()
  if (!apiKey) return undefined
  return {
    apiKey,
    model: env.TELEGRAM_STT_MODEL?.trim() || 'gpt-transcribe',
    languages: env.TELEGRAM_STT_LANGUAGES?.trim() || undefined,
    endpoint: 'https://api.openai.com/v1/audio/transcriptions',
  }
}

// The API picks its decoder from the upload's extension and rejects `oga`,
// Telegram's name for a voice note's OGG/Opus, so name the upload after the
// container.
const EXT_BY_MIME: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'video/ogg': 'ogg',
  'application/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'mp4',
  'video/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
}
const EXT_BY_SUFFIX: Record<string, string> = { oga: 'ogg', opus: 'ogg' }

export function uploadName(mime: string | undefined, filePath: string | undefined): string | undefined {
  const byMime = mime ? EXT_BY_MIME[mime.toLowerCase()] : undefined
  if (byMime) return `audio.${byMime}`
  const suffix = filePath?.includes('.') ? filePath.split('.').pop()!.toLowerCase() : ''
  const ext = EXT_BY_SUFFIX[suffix] ?? (Object.values(EXT_BY_MIME).includes(suffix) ? suffix : undefined)
  return ext ? `audio.${ext}` : undefined
}

export async function transcribe(
  audio: Uint8Array,
  name: string,
  cfg: SttConfig,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([audio]), name)
  form.append('model', cfg.model)
  // The API takes several languages as repeated fields, not one joined value.
  for (const lang of (cfg.languages ?? '').split(',').map(l => l.trim()).filter(Boolean)) {
    form.append('languages', lang)
  }
  form.append('response_format', 'text')
  const res = await fetchImpl(cfg.endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: form,
    signal,
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`transcription HTTP ${res.status}: ${body.slice(0, 300)}`)
  return body.trim()
}

type FileApi = {
  getFile(fileId: string, signal?: AbortSignal): Promise<{ file_path?: string; file_unique_id?: string }>
}

// Downloads a Telegram file into the inbox and transcribes it. Returns
// undefined, after a line on stderr, whenever it cannot: the message then
// reaches Claude as it would without STT.
export async function transcribeTelegramFile(opts: {
  api: FileApi
  token: string
  inboxDir: string
  fileId: string
  mime?: string
  size?: number
  cfg: SttConfig
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<{ path: string; text: string } | undefined> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const signal = AbortSignal.timeout(opts.timeoutMs ?? STT_TIMEOUT_MS)
  try {
    if (opts.size != null && opts.size > STT_MAX_BYTES) throw new Error(`file is ${opts.size} bytes`)
    const file = await opts.api.getFile(opts.fileId, signal)
    if (!file.file_path) throw new Error('Telegram returned no file_path')
    const name = uploadName(opts.mime, file.file_path)
    if (!name) throw new Error(`no transcribable container for ${opts.mime ?? file.file_path}`)

    const res = await fetchImpl(`https://api.telegram.org/file/bot${opts.token}/${file.file_path}`, { signal })
    if (!res.ok) throw new Error(`download HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'stt'
    const path = join(opts.inboxDir, `${Date.now()}-${uniqueId}.${name.split('.').pop()}`)
    mkdirSync(opts.inboxDir, { recursive: true })
    writeFileSync(path, bytes)

    const text = await transcribe(bytes, name, opts.cfg, signal, fetchImpl)
    if (!text) throw new Error('empty transcript')
    return { path, text }
  } catch (err) {
    process.stderr.write(`telegram channel: speech to text failed: ${err}\n`)
    return undefined
  }
}
