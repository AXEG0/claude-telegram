// The no-follow open of text_files (see textfiles.ts): a link put at a file's
// real path after that path resolves makes the open fail, so the link's
// target is never read. The link takes the file's place inside the resolve
// itself, so the test runs no race. Every other path resolves as it would.
import { afterAll, expect, mock, test } from 'bun:test'
import * as fsp from 'fs/promises'
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'textfiles-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const swapped = join(dir, 'note.md')
const secret = join(dir, 'secret.md')
const resolve = fsp.realpath
mock.module('fs/promises', () => ({
  ...fsp,
  realpath: async (...args: Parameters<typeof fsp.realpath>) => {
    const real = await resolve(...args)
    if (args[0] === swapped) {
      unlinkSync(swapped)
      symlinkSync(secret, swapped)
    }
    return real
  },
}))
const { readTextFiles } = await import('./textfiles.ts')

test('a link put at a file\'s real path after the path resolves makes the open fail, and its target is not read', async () => {
  writeFileSync(swapped, 'The text meant to go.')
  writeFileSync(secret, 'SECRET-CONTENT')
  const read = readTextFiles([swapped], join(dir, 'state'), 'nothing was sent')
  await expect(read).rejects.toThrow(`text_files: ${swapped} cannot be opened (ELOOP), so nothing was sent`)
})
