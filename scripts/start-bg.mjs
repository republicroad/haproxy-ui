/**
 * Start a long-running process detached from this shell session.
 *
 * Roots out the "shell tool waits forever" problem: the child gets
 * stdio "ignore" (no inherited pipes, nothing for the parent to wait
 * on) and is detached into its own process group, so this script exits
 * immediately after writing the PID file.
 *
 * Usage:
 *   node scripts/start-bg.mjs --pidfile <path> [--name <label>] -- <cmd> [args...]
 *
 * Behaviour:
 *   - refuses to double-start: if the pidfile exists and the PID is
 *     alive, exits 0 with "already running"
 *   - prints "started <name> (pid N)" on success
 *
 * Stop the process later with:
 *   taskkill /PID <pid> /F /T   (Windows)
 *   kill <pid>                  (POSIX)
 */
import { spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"

function arg(name, argv) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const argv = process.argv.slice(2)
const sep = argv.indexOf("--")
if (sep === -1 || sep + 1 >= argv.length) {
  console.error("usage: node scripts/start-bg.mjs --pidfile <path> [--name <label>] -- <cmd> [args...]")
  process.exit(2)
}
const pidfile = arg("--pidfile", argv)
const name = arg("--name", argv) ?? argv[sep + 1]
const cmd = argv[sep + 1]
const args = argv.slice(sep + 2)

if (!pidfile) {
  console.error("--pidfile is required")
  process.exit(2)
}

// Refuse to double-start.
if (existsSync(pidfile)) {
  const existing = Number(readFileSync(pidfile, "utf8").trim())
  let alive = false
  try {
    process.kill(existing, 0)
    alive = true
  } catch {
    alive = false
  }
  if (alive) {
    console.log(`${name} already running (pid ${existing})`)
    process.exit(0)
  }
}

const child = spawn(cmd, args, {
  detached: true,
  stdio: "ignore",
  env: process.env,
  windowsHide: true,
})
child.unref()

if (child.pid) {
  writeFileSync(pidfile, String(child.pid))
  console.log(`started ${name} (pid ${child.pid})`)
} else {
  console.error(`failed to start ${name}`)
  process.exit(1)
}
