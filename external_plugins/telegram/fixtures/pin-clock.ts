// A hook run by a test on the driven clock: its Date.now() reads the test's
// clock, given in TELEGRAM_TEST_CLOCK_NOW, so the times it writes agree with
// the server's.
import { setSystemTime } from 'bun:test'

setSystemTime(new Date(Number(process.env.TELEGRAM_TEST_CLOCK_NOW)))
