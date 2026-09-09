import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { execSync } from "node:child_process"

const pidFile = join(process.env.TEMP ?? "/tmp", "haproxy-ui-e2e-mock.pid")

export default function globalTeardown() {
  try {
    // pidFile holds one pid per line (mock 9090 and mock 9091)
    const pids = readFileSync(pidFile, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    for (const pid of pids) {
      try {
        if (process.platform === "win32") {
          execSync(`taskkill /PID ${pid} /F /T`, { stdio: "ignore" })
        } else {
          execSync(`kill ${pid}`, { stdio: "ignore" })
        }
      } catch {
        // already gone
      }
    }
  } catch {
    // pid file missing
  }
  rmSync(pidFile, { force: true })
}
