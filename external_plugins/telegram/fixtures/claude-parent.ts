// A real process with argv[0] set to claude by the integration test. Its
// child is the production server, with only Telegram HTTP replaced offline.
import { spawn } from 'child_process'
import { join } from 'path'

const child = spawn(process.execPath, [
  '--preload', join(import.meta.dir, 'telegram-preload.ts'),
  join(import.meta.dir, '..', 'server.ts'),
], { stdio: 'inherit' })
child.on('exit', code => process.exit(code ?? 1))
child.on('error', err => { console.error(err); process.exit(1) })
