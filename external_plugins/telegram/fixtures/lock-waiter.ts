// Opens a lock file without creating it, blocks on its exclusive flock, and
// once granted prints whether the file is still at its path. A process that
// waits on a writer's lock this way learns whether the sweep that held it
// deleted the file before letting go.
import { existsSync, openSync } from 'fs'
import { flock, LOCK_EX } from '../buttons.ts'

const path = process.argv[2]!
const fd = openSync(path, 'r')
const granted = flock()!(fd, LOCK_EX) === 0
console.log(JSON.stringify({ granted, exists: existsSync(path) }))
