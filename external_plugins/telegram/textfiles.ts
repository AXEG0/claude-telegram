// A message whose text is read from files: reply and edit_message take
// text_files, a list of absolute paths of UTF-8 text files, in place of text.
// Their text, in order, is the message text, which then takes the path typed
// text takes, so the session sends a body it already wrote without typing it
// out again in the call.
//
// Each path is read once, through one handle: its real path is resolved, the
// rule that keeps the channel's own state from being sent is applied to it,
// and that very string is opened read-only, not following a link at its last
// step and not waiting on a pipe; the handle must be a regular file, and the
// bytes read from it, for all the call's files together, stay within
// TEXT_FILES_MAX. Every call here is asynchronous, so a path on a stalled
// mount holds its own call and not the server. Nothing here prints a file's
// content: a refusal names the path and the reason.
//
// This file carries no dependencies beyond Node's.

import { createHash } from 'crypto'
import { constants } from 'fs'
import { open, realpath } from 'fs/promises'
import { isAbsolute, join, sep } from 'path'

// The bytes all of one call's files may hold together.
export const TEXT_FILES_MAX = 256 * 1024

// The rule both reply arguments that take a path apply, files and
// text_files: a path whose real path lies inside the channel's state folder,
// and outside its inbox, is the channel's own state. It takes a path already
// resolved and the state folder's own real path, and makes no file call.
export function channelState(real: string, stateReal: string): boolean {
  const inbox = join(stateReal, 'inbox')
  return real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)
}

export const stateRefusal = (path: string) => `refusing to send channel state: ${path}`

// Which of text and text_files a call passed, refused unless it passed
// exactly one where one is needed, each in its shape. An argument counts as
// passed when its key is present at all. edit_message may pass neither when
// it passes buttons, which its own refusal covers.
export function textArgument(args: Record<string, unknown>, undone: string, needed: boolean): 'text' | 'text_files' | undefined {
  const hasText = 'text' in args
  const hasFiles = 'text_files' in args
  if (hasText && hasFiles) throw new Error(`pass text or text_files, not both, so ${undone}`)
  if (hasFiles) {
    const files = args.text_files
    if (!Array.isArray(files) || files.length === 0 || !files.every(f => typeof f === 'string')) {
      throw new Error(`text_files must be a non-empty list of absolute paths, such as ["/tmp/digest.md"], so ${undone}`)
    }
    return 'text_files'
  }
  if (hasText) {
    if (typeof args.text !== 'string') throw new Error(`text must be a string, so ${undone}`)
    return 'text'
  }
  if (needed) throw new Error(`pass text or text_files, so ${undone}`)
  return undefined
}

export type TextFile = { path: string; bytes: number; sha256: string }
export type FileText = { text: string; files: TextFile[] }

// The text of one file as the message takes it: CRLF read as LF, a leading
// byte-order mark dropped by the decoder, and line breaks at both ends gone.
const LINE_BREAKS_AT_ENDS = /^\n+|\n+$/g
const BLANK = /^[ \t\r\n]*$/

// Reads every path in turn and joins their texts with one blank line between
// them. stateDir is the channel's state folder, resolved here in the same
// call: one that does not resolve leaves nothing to refuse, as for files.
export async function readTextFiles(paths: string[], stateDir: string, undone: string): Promise<FileText> {
  // A refusal names the path and the reason, never the content.
  const refuse = (path: string, why: string): never => { throw new Error(`text_files: ${path} ${why}, so ${undone}`) }
  let stateReal: string | undefined
  try { stateReal = await realpath(stateDir) } catch {}
  const texts: string[] = []
  const files: TextFile[] = []
  // Sizes the call's handles reported, and bytes read, so far.
  let reported = 0
  let read = 0
  for (const path of paths) {
    if (!isAbsolute(path)) refuse(path, 'is not an absolute path')
    let real: string
    try {
      real = await realpath(path)
    } catch (err) {
      return refuse(path, `does not resolve (${codeOf(err)})`)
    }
    if (stateReal !== undefined && channelState(real, stateReal)) throw new Error(`${stateRefusal(path)}, so ${undone}`)
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (err) {
      return refuse(path, `cannot be opened (${codeOf(err)})`)
    }
    let bytes: Buffer
    try {
      const st = await handle.stat()
      if (!st.isFile()) refuse(path, 'is not a regular file')
      reported += st.size
      if (reported > TEXT_FILES_MAX) refuse(path, `takes the call's files over ${TEXT_FILES_MAX / 1024} KiB`)
      // At most what the call has left and one byte, so a file that grew, or
      // reports no size, cannot carry the call past the limit unseen.
      const room = TEXT_FILES_MAX - read + 1
      const buf = Buffer.alloc(room)
      let got = 0
      while (got < room) {
        const { bytesRead } = await handle.read(buf, got, room - got, null)
        if (bytesRead === 0) break
        got += bytesRead
      }
      read += got
      if (read > TEXT_FILES_MAX) refuse(path, `takes the call's files over ${TEXT_FILES_MAX / 1024} KiB`)
      bytes = buf.subarray(0, got)
    } finally {
      await handle.close()
    }
    // Bytes that are not valid in the encoding and NUL bytes: the two signs of
    // binary data grep's manual names.
    if (bytes.includes(0)) refuse(path, 'holds a NUL byte, a sign of binary data')
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      return refuse(path, 'is not UTF-8 text')
    }
    if (BLANK.test(text)) refuse(path, 'holds no text')
    texts.push(text.replace(/\r\n/g, '\n').replace(LINE_BREAKS_AT_ENDS, ''))
    files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  return { text: texts.join('\n\n'), files }
}

const codeOf = (err: unknown): string => {
  const code = (err as { code?: unknown })?.code
  return typeof code === 'string' ? code : 'error'
}

// The server log's line for a call's files: each path, its size and its
// sha256, never its text.
export const filesLine = (files: TextFile[]): string =>
  files.map(f => `${f.path} (${f.bytes} bytes, sha256 ${f.sha256})`).join(', ')
