// The production server's preload under a driven clock: the offline Telegram
// fake, then Bun's fake timers, which stop every clock in this process
// (Date.now, performance.now, setTimeout, setInterval, Bun.sleep). The clock
// starts at the time the test gives in TELEGRAM_TEST_CLOCK_NOW, so every
// server of a test shares one timeline, and it moves only when the test asks:
// the test writes the time to move to into clock/<pid> in the state folder and
// sends SIGUSR2. The clock then moves from timer to timer, so each timer fires
// at its own due time and in its order, and the work a timer starts, an
// awaited sleep's next step included, runs before the next timer. It writes
// where it stopped to clock/<pid>.now. The test moves every server to the same
// time, so a server that started while the clock was moving catches up on its
// next move. What the server has taken from its input, in bytes, and whether
// the input ended, it writes to clock/<pid>.input: the test moves the clock only
// once each server has taken all it wrote, so a request is read at the time
// the test wrote it.
import './telegram-preload.ts'
import { jest } from 'bun:test'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

const folder = join(process.env.TELEGRAM_STATE_DIR!, 'clock')
mkdirSync(folder, { recursive: true })
const request = join(folder, String(process.pid))

jest.useFakeTimers({ now: Number(process.env.TELEGRAM_TEST_CLOCK_NOW) || Date.now() } as never)

// setImmediate is not faked, so it lets pending I/O and promise chains run.
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

function stopped(n: number): void {
  writeFileSync(`${request}.now.tmp`, JSON.stringify({ n, now: Date.now() }))
  renameSync(`${request}.now.tmp`, `${request}.now`)
}

// Counted as the input hands each chunk, and its end, to the server's own
// listeners, once they have run. A listener of its own here would start the
// input flowing before the server listens, and lose what came first.
const input = join(folder, `${process.pid}.input`)
let taken = 0
let ended = false
function took(): void {
  writeFileSync(`${input}.tmp`, JSON.stringify({ bytes: taken, ended }))
  renameSync(`${input}.tmp`, input)
}
const emit = process.stdin.emit
process.stdin.emit = function (this: typeof process.stdin, event: string | symbol, ...args: unknown[]) {
  try {
    return emit.call(this, event, ...args)
  } finally {
    if (event === 'data') {
      const chunk = args[0] as string | Uint8Array
      taken += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
      took()
    }
    if ((event === 'end' || event === 'close') && !ended) {
      ended = true
      took()
    }
  }
} as typeof process.stdin.emit

let moving = Promise.resolve()
process.on('SIGUSR2', () => {
  moving = moving.then(async () => {
    const { n, to } = JSON.parse(readFileSync(request, 'utf8')) as { n: number; to: number }
    // One more timer, due at the time to move to, keeps the clock from
    // passing it.
    const stop = setTimeout(() => {}, Math.max(0, to - Date.now()))
    for (let still = 0; Date.now() < to;) {
      const before = Date.now()
      jest.advanceTimersToNextTimer()
      for (let i = 0; i < 3; i++) await turn()
      // Timers that keep coming due at the same instant would hold the clock
      // there; after a thousand of them it moves 1 ms.
      still = Date.now() === before ? still + 1 : 0
      if (still > 1000) { jest.advanceTimersByTime(1); still = 0 }
    }
    clearTimeout(stop)
    stopped(n)
  }).catch(err => { process.stderr.write(`telegram test clock: ${err}\n`) })
})
// The test signals only a server whose clock it can see, so the clock shows
// only once the signal has a handler: unhandled, SIGUSR2 ends the process.
stopped(0)
