import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const pidFile = join(process.env.TEMP ?? "/tmp", "haproxy-ui-e2e-mock.pid")

function startMock(port) {
  const child = spawn(
    process.execPath,
    ["scripts/mock-dataplaneapi.mjs"],
    { cwd: process.cwd(), env: { ...process.env, MOCK_PORT: String(port) }, detached: true, stdio: "ignore" },
  )
  child.unref()
  return child.pid
}

async function waitReady(port) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/v3/services/haproxy/runtime/info`, {
        headers: { authorization: "Basic YWRtaW46YWRtaW4=" },
      })
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`mock dataplaneapi failed to start on :${port}`)
}

export default async function globalSetup() {
  const pids = [startMock(9090), startMock(9091)]
  writeFileSync(pidFile, pids.join("\n"))
  await waitReady(9090)
  await waitReady(9091)
}
