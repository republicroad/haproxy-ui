import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const pidFile = join(process.env.TEMP ?? "/tmp", "haproxy-ui-e2e-mock.pid")

export default async function globalSetup() {
  const child = spawn(
    process.execPath,
    ["scripts/mock-dataplaneapi.mjs"],
    { cwd: process.cwd(), env: { ...process.env, MOCK_PORT: "9090" }, detached: true, stdio: "ignore" },
  )
  child.unref()
  writeFileSync(pidFile, String(child.pid))

  // wait for mock readiness
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://localhost:9090/v3/services/haproxy/runtime/info", {
        headers: { authorization: "Basic YWRtaW46YWRtaW4=" },
      })
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error("mock dataplaneapi failed to start")
}
