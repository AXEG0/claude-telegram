import { afterEach, describe, expect, jest, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FILE_LIMIT_MS, fetchPhoto, STT_MAX_BYTES, sttConfig, transcribe, transcribeTelegramFile, uploadName, type SttConfig } from './stt.ts'

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
    expect(r.reason).toBeUndefined()
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
    expect(r.text).toBeUndefined()
    expect(r.reason).toBe(`file is ${STT_MAX_BYTES + 1} bytes`)
    expect(asked).toBe(false)
  })

  test('a slow transcription gives up at the limit, with the saved file', async () => {
    const inboxDir = mkdtempSync(join(tmpdir(), 'stt-'))
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('api.telegram.org')) return new Response(new Uint8Array([1]))
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))
    }) as typeof fetch
    const t0 = Date.now()
    const r = await transcribeTelegramFile({ api, token: 'T', inboxDir, fileId: 'f', mime: 'audio/ogg', cfg, limitMs: 200, fetchImpl: impl })
    expect(r.text).toBeUndefined()
    expect(r.reason).toBe('transcription gave no answer within 0.2 s')
    expect(r.path?.endsWith('-u1.ogg')).toBe(true)
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  test('an API error comes back as the reason, so the message goes through untranscribed', async () => {
    const inboxDir = mkdtempSync(join(tmpdir(), 'stt-'))
    const f = fakeFetch(url => (url.includes('api.telegram.org') ? new Response(new Uint8Array([1])) : new Response('no', { status: 500 })))
    const r = await transcribeTelegramFile({ api, token: 'T', inboxDir, fileId: 'f', mime: 'audio/ogg', cfg, fetchImpl: f.impl })
    expect(r.text).toBeUndefined()
    expect(r.reason).toBe('transcription HTTP 500: no')
  })

  test('a file lookup that hangs gives up at the limit too', async () => {
    const hanging = {
      getFile: (_id: string, signal?: AbortSignal) =>
        new Promise<{ file_path?: string }>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason))),
    }
    const t0 = Date.now()
    const r = await transcribeTelegramFile({ api: hanging, token: 'T', inboxDir: mkdtempSync(join(tmpdir(), 'stt-')), fileId: 'f', mime: 'audio/ogg', cfg, limitMs: 200 })
    expect(r.reason).toBe('getFile gave no answer within 0.2 s')
    expect(r.path).toBeUndefined()
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

// The file work under fake timers, with the default limit: each step's time
// and reason, read from what comes back.
describe('the file work and its limit', () => {
  afterEach(() => jest.useRealTimers())
  const later = <T>(ms: number, value: () => T) => new Promise<T>(resolve => setTimeout(() => resolve(value()), ms))
  // Moves the fake clock from timer to timer until the work settles or the
  // clock reaches `until`; returns whether it settled.
  async function settle(work: Promise<unknown>, until: number): Promise<boolean> {
    let done = false
    void work.then(() => { done = true }, () => { done = true })
    const end = Date.now() + until
    // setImmediate is not faked: each turn lets the work's I/O and promise
    // chains run before the clock moves.
    const turns = async () => { for (let j = 0; j < 5 && !done; j++) await new Promise(r => setImmediate(r)) }
    for (let i = 0; i < 10_000 && !done && Date.now() < end; i++) {
      await turns()
      if (done) break
      jest.advanceTimersToNextTimer()
    }
    await turns()
    return done
  }
  const inbox = () => mkdtempSync(join(tmpdir(), 'stt-'))
  const file = (path = 'voice/file_1.oga') => ({ file_path: path, file_unique_id: 'u1' })

  test('S1 getFile and the download answering at 45 s still give the transcript, with each step timed', async () => {
    jest.useFakeTimers()
    const slowApi = { getFile: () => later(45_000, () => file()) }
    const impl = (async (input: string | URL | Request) =>
      String(input).includes('api.telegram.org') ? later(45_000, () => new Response(new Uint8Array([7]))) : new Response('spoken')) as typeof fetch
    const work = transcribeTelegramFile({ api: slowApi, token: 'T', inboxDir: inbox(), fileId: 'f', mime: 'audio/ogg', cfg, fetchImpl: impl })
    expect(await settle(work, FILE_LIMIT_MS + 1000)).toBe(true)
    const r = await work
    expect(r.reason).toBeUndefined()
    expect(r.text).toBe('spoken')
    expect(r.steps.getFile).toBe(45_000)
    expect(r.steps.download).toBe(45_000)
  })

  test('S2 the limit reached in each step names the step and the limit, with the saved file once the download finished', async () => {
    jest.useFakeTimers()
    const never = () => new Promise<never>(() => {})
    const cases: [string, Parameters<typeof transcribeTelegramFile>[0]['api'], typeof fetch, boolean][] = [
      ['getFile', { getFile: never }, (async () => new Response('x')) as typeof fetch, false],
      ['download', { getFile: async () => file() }, (async () => never()) as typeof fetch, false],
      ['transcription', { getFile: async () => file() }, (async (input: string | URL | Request) =>
        String(input).includes('api.telegram.org') ? new Response(new Uint8Array([1])) : never()) as typeof fetch, true],
    ]
    for (const [step, stepApi, impl, saved] of cases) {
      const t0 = Date.now()
      const work = transcribeTelegramFile({ api: stepApi, token: 'T', inboxDir: inbox(), fileId: 'f', mime: 'audio/ogg', cfg, fetchImpl: impl })
      expect(await settle(work, FILE_LIMIT_MS + 1000)).toBe(true)
      const r = await work
      expect(Date.now() - t0).toBe(FILE_LIMIT_MS)
      expect(r.reason).toBe(`${step} gave no answer within 300 s`)
      expect(r.path !== undefined).toBe(saved)
    }
    // A photo's download, the same.
    const t0 = Date.now()
    const photo = fetchPhoto({ api: { getFile: async () => file('photos/file_2.jpg') }, token: 'T', inboxDir: inbox(), fileId: 'p', fetchImpl: (async () => never()) as typeof fetch })
    expect(await settle(photo, FILE_LIMIT_MS + 1000)).toBe(true)
    expect((await photo).reason).toBe('download gave no answer within 300 s')
    expect(Date.now() - t0).toBe(FILE_LIMIT_MS)
  })

  test('S3 a failed transcription, download, inbox write, empty transcript and file over 20 MB each come back with their reason whole, naming the step', async () => {
    const body = 'x'.repeat(250)
    const failing = (download: number, stt: Response) => (async (input: string | URL | Request) =>
      String(input).includes('api.telegram.org') ? new Response(new Uint8Array([1]), { status: download }) : stt) as typeof fetch
    const run = (impl: typeof fetch, size?: number) =>
      transcribeTelegramFile({ api: { getFile: async () => file() }, token: 'T', inboxDir: inbox(), fileId: 'f', mime: 'audio/ogg', size, cfg, fetchImpl: impl })
    expect((await run(failing(200, new Response(body, { status: 500 })))).reason).toBe(`transcription HTTP 500: ${body}`)
    expect((await run(failing(404, new Response('unused'))))).toMatchObject({ reason: 'download HTTP 404' })
    expect((await run(failing(404, new Response('unused')))).path).toBeUndefined()
    expect((await run(failing(200, new Response('  \n'))))).toMatchObject({ reason: 'empty transcript' })
    expect((await run(failing(200, new Response('  \n')))).path).toBeDefined()
    expect((await run(failing(200, new Response('unused')), STT_MAX_BYTES + 1)).reason).toBe(`file is ${STT_MAX_BYTES + 1} bytes`)

    // A call that throws outright says only what failed; the reason puts the
    // running step in front of it.
    const reset = () => { throw new TypeError('fetch failed: connection reset') }
    const throwing = (where: 'download' | 'transcription') => (async (input: string | URL | Request) => {
      const download = String(input).includes('api.telegram.org')
      if ((where === 'download') === download) reset()
      return download ? new Response(new Uint8Array([1])) : new Response('unused')
    }) as typeof fetch
    expect((await run(throwing('download'))).reason).toBe('download: fetch failed: connection reset')
    expect((await run(throwing('transcription')))).toMatchObject({ reason: 'transcription: fetch failed: connection reset' })
    expect((await run(throwing('transcription'))).path).toBeDefined()
    const photo = await fetchPhoto({ api: { getFile: async () => file('photos/file_2.jpg') }, token: 'T', inboxDir: inbox(), fileId: 'p', fetchImpl: throwing('download') })
    expect(photo.reason).toBe('download: fetch failed: connection reset')
    // The inbox write is the download's last part: a folder that cannot be
    // made, as on a full disk, names it too.
    const blocked = join(inbox(), 'inbox')
    writeFileSync(blocked, 'a file where the inbox should be')
    const unsaved = await transcribeTelegramFile({ api: { getFile: async () => file() }, token: 'T', inboxDir: blocked, fileId: 'f', mime: 'audio/ogg', cfg, fetchImpl: failing(200, new Response('unused')) })
    expect(unsaved.reason).toStartWith('download: ')
    expect(unsaved.reason).toMatch(/EEXIST|ENOTDIR/)
    expect(unsaved.path).toBeUndefined()
  })

  test('S4 a fetch that ignores its abort signal still ends at the limit', async () => {
    jest.useFakeTimers()
    // Answers only after twice the limit, whatever its signal says.
    const deaf = (async () => later(2 * FILE_LIMIT_MS, () => new Response(new Uint8Array([1])))) as typeof fetch
    const t0 = Date.now()
    const work = transcribeTelegramFile({ api: { getFile: async () => file() }, token: 'T', inboxDir: inbox(), fileId: 'f', mime: 'audio/ogg', cfg, fetchImpl: deaf })
    let at = 0
    void work.then(() => { at = Date.now() })
    expect(await settle(work, FILE_LIMIT_MS + 1000)).toBe(true)
    expect(at - t0).toBe(FILE_LIMIT_MS)
    expect((await work).reason).toBe('download gave no answer within 300 s')
  })
})
