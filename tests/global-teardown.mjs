import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { execSync } from "node:child_process"

const pidFile = join(process.env.TEMP ?? "/tmp", "haproxy-ui-e2e-mock.pid")

export default function globalTeardown() {
  try {
    const pid = readFileSync(pidFile, "utf8").trim()
    if (process.platform === "win32") {
      execSync(`taskkill /PID ${pid} /F /T`, { stdio: "ignore" })
    } else {
      execSync(`kill ${pid}`, { stdio: "ignore" })
    }
  } catch {
    // already gone
  }
  rmSync(pidFile, { force: true })
}
