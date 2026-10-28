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
// next move.
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
