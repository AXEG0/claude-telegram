// Follows one append-only log: each read returns the lines ended since the
// last read.
//
// The follower keeps the log open between reads, and starts again from the
// top when the path no longer names the file it holds: the file was deleted,
// as the turn-end hook's weekly sweep deletes an old log, or replaced. A byte
// offset alone cannot tell a new file from the old one grown or kept at the
// same size, and would skip the new file's lines or read from the middle of
// one. While the old file is held open, its inode cannot be given to a new
// file, so a new file at the path always reads as new. Whatever the old file
// still held unread is read before it is let go.
//
// Node only, like failures.ts, which the hook imports before `bun install`.

import { closeSync, fstatSync, openSync, readSync, statSync, type Stats } from 'fs'

export function createLogFollower(path: string) {
  let fd: number | undefined
  let offset = 0

  const stat = (): Stats | undefined => { try { return statSync(path) } catch { return undefined } }
  const same = (a: Stats, b: Stats) => a.ino === b.ino && a.dev === b.dev

  // The ended lines from the offset to the file's end; a line not yet ended
  // stays for the next read. The offset moves by the bytes up to the last line
  // break, so a byte that is not UTF-8 cannot shift it. A file cut back below
  // what was read is read again from its start; one cut back and written
  // again to its old size or past it is not told apart from one appended to,
  // which no writer of these logs does.
  function take(): string[] {
    const size = fstatSync(fd!).size
    if (size < offset) offset = 0
    if (size === offset) return []
    const buf = Buffer.alloc(size - offset)
    const got = readSync(fd!, buf, 0, buf.length, offset)
    const last = buf.subarray(0, got).lastIndexOf(0x0a)
    if (last < 0) return []
    offset += last + 1
    return buf.subarray(0, last).toString('utf8').split('\n')
  }

  return {
    read(): string[] {
      const out: string[] = []
      const now = stat()
      if (fd !== undefined && !(now && same(now, fstatSync(fd)))) {
        out.push(...take())
        closeSync(fd)
        fd = undefined
      }
      if (fd === undefined) {
        if (!now) return out
        try { fd = openSync(path, 'r') } catch { return out }
        offset = 0
      }
      out.push(...take())
      return out
    },
    // Whether the path holds bytes not read yet, a line not yet ended included.
    waiting(): boolean {
      const now = stat()
      if (fd === undefined) return !!now && now.size > 0
      const held = fstatSync(fd)
      // Grown, or cut back below what was read and written again.
      if (held.size > 0 && held.size !== offset) return true
      return !!now && !same(now, held) && now.size > 0
    },
    close(): void {
      if (fd !== undefined) closeSync(fd)
      fd = undefined
    },
  }
}
