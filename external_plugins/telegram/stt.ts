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
// A message's whole file work, its lookup, download and any transcription,
// counted from its arrival, or from its replay. The work runs beside the
// update loop, so this bounds how long one message can hold its own sender's
// later messages; nothing else waits for it. The longest audio file the
// transcription accepts took 65 s, and the slowest lookup seen took 55 s.
export const FILE_LIMIT_MS = 300_000
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

// Each file step's time in ms, for the record.
export type Steps = { getFile?: number; download?: number; transcribe?: number }
// A message's file work: the file saved, the transcript, or the reason it
// went on without them, the step and the cause.
export type FileWork = { path?: string; text?: string; reason?: string; steps: Steps }

type Step = keyof Steps
const STEP_NAMES: Record<Step, string> = { getFile: 'getFile', download: 'download', transcribe: 'transcription' }

// The work's running step, timed, and the signal its calls take.
type Job = { signal: AbortSignal; steps: Steps; step?: Step; since: number }

async function timed<T>(job: Job, step: Step, run: () => Promise<T>): Promise<T> {
  job.step = step
  job.since = Date.now()
  try {
    return await run()
  } finally {
    job.steps[step] = Date.now() - job.since
    job.step = undefined
  }
}

// Runs the work until the limit, counted from `from`, as withinLimit does in
// buttons.ts: the signal goes to every call, and the race ends the work at the
// limit even when a call ignores its signal. The reason names the step the
// limit cut.
async function withinFileLimit(
  from: number,
  limitMs: number,
  run: (job: Job) => Promise<Omit<FileWork, 'steps'>>,
): Promise<FileWork> {
  const controller = new AbortController()
  const job: Job = { signal: controller.signal, steps: {}, since: Date.now() }
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<Omit<FileWork, 'steps'>>(resolve => {
    timer = setTimeout(() => {
      const step = job.step
      if (step) job.steps[step] = Date.now() - job.since
      resolve({ reason: `${step ? STEP_NAMES[step] : 'the work'} gave no answer within ${limitMs / 1000} s` })
      controller.abort()
    }, Math.max(0, from + limitMs - Date.now()))
  })
  try {
    const out = await Promise.race([run(job).catch(err => ({ reason: err instanceof Error ? err.message : String(err) })), late])
    return { ...out, steps: job.steps }
  } finally {
    clearTimeout(timer)
  }
}

type FileOpts = {
  api: FileApi
  token: string
  inboxDir: string
  fileId: string
  // The arrival, or the replay, that the limit counts from.
  from?: number
  limitMs?: number
  fetchImpl?: typeof fetch
}

// getFile, then the download into the inbox, each timed: the one fetch of
// photos and speech alike. name gives the saved file's extension from
// Telegram's file_path, or throws when the file cannot be used.
async function fetchFile(job: Job, opts: FileOpts, ext: (filePath: string) => string, saved: (path: string) => void): Promise<{ path: string; bytes: Uint8Array }> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const file = await timed(job, 'getFile', () => opts.api.getFile(opts.fileId, job.signal))
  if (!file.file_path) throw new Error('getFile gave no file_path')
  const suffix = ext(file.file_path)
  const bytes = await timed(job, 'download', async () => {
    const res = await fetchImpl(`https://api.telegram.org/file/bot${opts.token}/${file.file_path}`, { signal: job.signal })
    if (!res.ok) throw new Error(`download HTTP ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  })
  const uniqueId = (file.file_unique_id ?? '').replace(/[^a-zA-Z0-9_-]/g, '') || 'file'
  const path = join(opts.inboxDir, `${Date.now()}-${uniqueId}.${suffix}`)
  mkdirSync(opts.inboxDir, { recursive: true })
  writeFileSync(path, bytes)
  saved(path)
  return { path, bytes }
}

// Downloads a photo into the inbox. Whenever it cannot, the reason comes back,
// after a line on stderr, and the photo reaches Claude as an attachment.
export async function fetchPhoto(opts: FileOpts): Promise<FileWork> {
  const work = await withinFileLimit(opts.from ?? Date.now(), opts.limitMs ?? FILE_LIMIT_MS, async job => {
    const { path } = await fetchFile(job, opts, filePath => (filePath.includes('.') ? filePath.split('.').pop()!.replace(/[^a-zA-Z0-9]/g, '') : '') || 'jpg', () => {})
    return { path }
  })
  if (work.reason) process.stderr.write(`telegram channel: photo download failed: ${work.reason}\n`)
  return work
}

// Downloads a Telegram file into the inbox and transcribes it. Whenever it
// cannot, the reason comes back, after a line on stderr, with the saved file
// when the download finished: the message then reaches Claude untranscribed,
// with the reason.
export async function transcribeTelegramFile(opts: FileOpts & {
  mime?: string
  size?: number
  cfg: SttConfig
}): Promise<FileWork> {
  let saved: string | undefined
  const work = await withinFileLimit(opts.from ?? Date.now(), opts.limitMs ?? FILE_LIMIT_MS, async job => {
    if (opts.size != null && opts.size > STT_MAX_BYTES) throw new Error(`file is ${opts.size} bytes`)
    let name = ''
    const { path, bytes } = await fetchFile(job, opts, filePath => {
      const upload = uploadName(opts.mime, filePath)
      if (!upload) throw new Error(`no transcribable container for ${opts.mime ?? filePath}`)
      name = upload
      return upload.split('.').pop()!
    }, path => { saved = path })
    const text = await timed(job, 'transcribe', () => transcribe(bytes, name, opts.cfg, job.signal, opts.fetchImpl ?? fetch))
    if (!text) throw new Error('empty transcript')
    return { path, text }
  })
  if (work.reason) {
    process.stderr.write(`telegram channel: speech to text failed: ${work.reason}\n`)
    return { ...(saved ? { path: saved } : {}), reason: work.reason, steps: work.steps }
  }
  return work
}
