// A real process with argv[0] set to claude by the hook tests. Its child is
// the plugin hook named by the first argument, reading this process's stdin.
import { spawnSync } from 'child_process'

const r = spawnSync(process.execPath, [process.argv[2]!], { stdio: 'inherit' })
process.exit(r.status ?? 1)
