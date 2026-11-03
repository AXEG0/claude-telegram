// A child process for log.test.ts: runs the writer's setup on the state folder
// it is given, then prints the lines one case names, and exits.
import { chmodSync, existsSync, mkdirSync, rmdirSync, rmSync, truncateSync, writeFileSync } from 'fs'
import { join } from 'path'
import { GrammyError } from 'grammy'
import { logCall, setupLog } from '../log.ts'

const [dir, kase] = process.argv.slice(2)
// The server log's bound, 1 MiB, and the call record's, 16 MiB.
const SERVER_BOUND = 1024 * 1024
const CALLS_BOUND = 16 * 1024 * 1024
const file = join(dir, 'logs', `server-${process.pid}.jsonl`)
const callFile = join(dir, 'logs', `calls-${process.pid}.jsonl`)
const done = (ms = 100) => setTimeout(() => process.exit(0), ms)

if (kase === 'import') {
  // log.ts is already imported above, setup not called.
  const listeners = process.listenerCount('warning')
  process.stdout.write(JSON.stringify({ write: process.stderr.write.name, error: console.error.name, listeners, logs: require('fs').existsSync(join(dir, 'logs')) }) + '\n')
  process.exit(0)
}
if (kase === 'call-before-setup') {
  // A call line before setup.
  logCall({ call: 'sendMessage', chat: '1', ms: 5, ok: true, message_id: 7 })
  process.stdout.write(JSON.stringify({ logs: existsSync(join(dir, 'logs')) }) + '\n')
  process.exit(0)
}
if (kase === 'reused' || kase === 'rotate-fails') {
  mkdirSync(join(dir, 'logs'), { recursive: true })
  writeFileSync(file, 'x'.repeat(SERVER_BOUND) + '\n')
}
if (kase === 'rotate-fails') mkdirSync(`${file}.1`)
setupLog(dir)

if (kase === 'lines') {
  process.stderr.write('telegram channel: a direct line\n')
  ;(process as any)['std' + 'err'].write('telegram channel: a computed name\n')
  console.error('telegram channel: an error:', new Error('boom'))
  const ge = new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code: 400, description: 'Bad Request: refused' } as any, 'sendMessage', { chat_id: 1, text: 'MARKER-MESSAGE-TEXT' } as any)
  console.warn('telegram channel: a console.warn line')
  console.error(new Error('100%s done'), 'and the next argument')
  process.emitWarning('a direct warning')
  process.emitWarning('a coded warning', { code: 'MY_CODE', detail: 'the coded warning\'s detail' })
  setTimeout(() => {}, 2 ** 31)
  const { EventEmitter } = require('events')
  const leaky = new EventEmitter()
  for (let i = 0; i < 11; i++) leaky.on('leak', () => {})
  // After a timer turn, as in the server: on Bun 1.3 the error's stack then
  // starts with a bare "Error", while its String keeps its name.
  setTimeout(() => { console.error('FATAL: grammY unable to handle:', ge); done() }, 10)
} else if (kase === 'nostate') {
  process.stderr.write('telegram channel: no state folder\n')
  done(50)
} else if (kase === 'reused') {
  process.stderr.write('telegram channel: after a reused pid\n')
  process.stderr.write('telegram channel: the next line\n')
  done(50)
} else if (kase === 'rotate-fails') {
  process.stderr.write('telegram channel: X\n')
  process.stderr.write('telegram channel: Y\n')
  done(50)
} else if (kase === 'ragged') {
  process.stderr.write('telegram channel: A\n')
  chmodSync(file, 0o400)
  process.stderr.write('telegram channel: B\n')
  chmodSync(file, 0o600)
  process.stderr.write('telegram channel: C\n')
  process.stderr.write('telegram channel: D\n')
  done(50)
} else if (kase === 'gone') {
  process.stderr.write('telegram channel: A\n')
  rmSync(join(dir, 'logs'), { recursive: true, force: true })
  process.stderr.write('telegram channel: B\n')
  process.stdout.write(JSON.stringify(require('fs').readFileSync(file, 'utf8').trim().split('\n').map((l: string) => JSON.parse(l).log)))
  rmSync(dir, { recursive: true, force: true })
  process.stderr.write('telegram channel: C\n')
  done(50)
} else if (kase === 'calls') {
  logCall({ call: 'sendMessage', chat: '1', ms: 5, ok: true, message_id: 7 })
  done(50)
} else if (kase === 'call-bounds') {
  // A call file past the server log's bound stays; one past its own moves.
  // The server log moves at its own bound.
  mkdirSync(join(dir, 'logs'), { recursive: true })
  writeFileSync(callFile, '')
  truncateSync(callFile, 2 * SERVER_BOUND)
  writeFileSync(file, '')
  truncateSync(file, SERVER_BOUND - 10)
  logCall({ call: 'a', ms: 1, ok: true })
  const past = { calls: existsSync(callFile), moved: existsSync(`${callFile}.1`) }
  truncateSync(callFile, CALLS_BOUND - 10)
  logCall({ call: 'b', ms: 1, ok: true })
  const atBound = { calls: existsSync(callFile), moved: existsSync(`${callFile}.1`) }
  process.stderr.write('telegram channel: one server line\n')
  const server = { server: existsSync(file), moved: existsSync(`${file}.1`) }
  process.stdout.write(JSON.stringify({ past, atBound, server }) + '\n')
  done(50)
} else if (kase === 'calls-lost') {
  // A folder where the call file goes: the line cannot land.
  mkdirSync(callFile, { recursive: true })
  logCall({ call: 'a', ms: 1, ok: true })
  rmdirSync(callFile)
  logCall({ call: 'b', ms: 1, ok: true })
  logCall({ call: 'c', ms: 1, ok: true })
  done(50)
} else if (kase === 'far-end') {
  process.on('uncaughtException', err => { process.stderr.write(`telegram channel: uncaught exception: ${err}\n`) })
  process.on('unhandledRejection', err => { process.stderr.write(`telegram channel: unhandled rejection: ${err}\n`) })
  process.stderr.write('telegram channel: before the far end goes\n')
  setTimeout(() => {
    process.stderr.write('telegram channel: after the far end went, 1\n')
    setTimeout(() => {
      process.stderr.write('telegram channel: after the far end went, 2\n')
      setTimeout(() => { throw new Error('boom') }, 50)
      void Promise.reject(new Error('rejected'))
      setTimeout(() => {
        process.stderr.write('telegram channel: shutting down\n')
        const u = process.cpuUsage()
        writeFileSync(join(dir, 'cpu.json'), JSON.stringify(u))
        process.exit(0)
      }, 1500)
    }, 200)
  }, 400)
}
