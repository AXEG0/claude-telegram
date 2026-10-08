import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { STT_MAX_BYTES, sttConfig, transcribe, transcribeTelegramFile, uploadName, type SttConfig } from './stt.ts'

const cfg: SttConfig = { apiKey: 'k', model: 'gpt-transcribe', endpoint: 'https://stt.test/v1' }

type Call = { url: string; form?: FormData; auth?: string }
function fakeFetch(handler: (url: string) => Response) {
  const calls: Call[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url, form: init?.body as FormData | undefined, auth: headers.Authorization })
    return handler(url)
  }) as typeof fetch
  return { impl, calls }
}

describe('sttConfig', () => {
  test('off without a key, gpt-transcribe by default', () => {
    expect(sttConfig({})).toBeUndefined()
    expect(sttConfig({ OPENAI_API_KEY: 'ambient' })).toBeUndefined()
    expect(sttConfig({ TELEGRAM_STT_OPENAI_KEY: ' k ' })).toEqual({
      apiKey: 'k',
      model: 'gpt-transcribe',
      languages: undefined,
      endpoint: 'https://api.openai.com/v1/audio/transcriptions',
    })
    expect(sttConfig({ TELEGRAM_STT_OPENAI_KEY: 'k', TELEGRAM_STT_MODEL: 'm', TELEGRAM_STT_LANGUAGES: 'en,zh' })?.languages).toBe('en,zh')
  })
})

describe('uploadName', () => {
  test('names the upload after the container, never oga', () => {
    expect(uploadName('audio/ogg', 'voice/file_1.oga')).toBe('audio.ogg')
    expect(uploadName(undefined, 'voice/file_1.oga')).toBe('audio.ogg')
    expect(uploadName(undefined, 'video_notes/file_3.mp4')).toBe('audio.mp4')
    expect(uploadName('audio/mpeg', 'music/file_2')).toBe('audio.mp3')
    expect(uploadName(undefined, 'documents/file_4.bin')).toBeUndefined()
  })
})

describe('transcribe', () => {
  test('posts the model, text format and each pinned language as its own field', async () => {
    const f = fakeFetch(() => new Response(' hello \n'))
    const text = await transcribe(new Uint8Array([1, 2]), 'audio.ogg', { ...cfg, languages: 'en, zh' }, undefined, f.impl)
    expect(text).toBe('hello')
    const form = f.calls[0]!.form!
    expect(f.calls[0]!.auth).toBe('Bearer k')
    expect(form.get('model')).toBe('gpt-transcribe')
    expect(form.get('response_format')).toBe('text')
    expect(form.getAll('languages')).toEqual(['en', 'zh'])
    expect((form.get('file') as File).name).toBe('audio.ogg')
  })

  test('an error status throws with the status', async () => {
    const f = fakeFetch(() => new Response('bad', { status: 400 }))
    await expect(transcribe(new Uint8Array([1]), 'audio.ogg', cfg, undefined, f.impl)).rejects.toThrow('HTTP 400')
  })
})

describe('transcribeTelegramFile', () => {
  const api = { getFile: async (_id: string, _signal?: AbortSignal) => ({ file_path: 'voice/file_1.oga', file_unique_id: 'u1' }) }

  test('downloads into the inbox and returns the transcript', async () => {
    const inboxDir = mkdtempSync(join(tmpdir(), 'stt-'))
    const f = fakeFetch(url =>
      url.startsWith('https://api.telegram.org/file/botTOKEN/voice/file_1.oga')
        ? new Response(new Uint8Array([9, 9, 9]))
        : new Response('spoken words'),
    )
    const r = await transcribeTelegramFile({ api, token: 'TOKEN', inboxDir, fileId: 'f', mime: 'audio/ogg', size: 3, cfg, fetchImpl: f.impl })
    expect(r?.text).toBe('spoken words')
    expect(r?.path.endsWith('-u1.ogg')).toBe(true)
    expect([...readFileSync(r!.path)]).toEqual([9, 9, 9])
    expect(f.calls.map(c => c.url)).toEqual(['https://api.telegram.org/file/botTOKEN/voice/file_1.oga', 'https://stt.test/v1'])
  })

  test('a file over the download limit is skipped before any call', async () => {
    let asked = false
    const r = await transcribeTelegramFile({
      api: { getFile: async () => { asked = true; return {} } },
      token: 'T', inboxDir: mkdtempSync(join(tmpdir(), 'stt-')), fileId: 'f', size: STT_MAX_BYTES + 1, cfg,
    })
    expect(r).toBeUndefined()
    expect(asked).toBe(false)
  })

  test('a slow transcription gives up at the timeout', async () => {
    const inboxDir = mkdtempSync(join(tmpdir(), 'stt-'))
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('api.telegram.org')) return new Response(new Uint8Array([1]))
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
    }) as typeof fetch
    const t0 = Date.now()
    const r = await transcribeTelegramFile({ api, token: 'T', inboxDir, fileId: 'f', mime: 'audio/ogg', cfg, timeoutMs: 200, fetchImpl: impl })
    expect(r).toBeUndefined()
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  test('an API error returns undefined, so the message goes through untranscribed', async () => {
    const inboxDir = mkdtempSync(join(tmpdir(), 'stt-'))
    const f = fakeFetch(url => (url.includes('api.telegram.org') ? new Response(new Uint8Array([1])) : new Response('no', { status: 500 })))
    expect(await transcribeTelegramFile({ api, token: 'T', inboxDir, fileId: 'f', mime: 'audio/ogg', cfg, fetchImpl: f.impl })).toBeUndefined()
  })

  test('a file lookup that hangs gives up at the timeout too', async () => {
    const hanging = {
      getFile: (_id: string, signal?: AbortSignal) =>
        new Promise<{ file_path?: string }>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason))),
    }
    const t0 = Date.now()
    const r = await transcribeTelegramFile({ api: hanging, token: 'T', inboxDir: mkdtempSync(join(tmpdir(), 'stt-')), fileId: 'f', mime: 'audio/ogg', cfg, timeoutMs: 200 })
    expect(r).toBeUndefined()
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})
