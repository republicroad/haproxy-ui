import { join, resolve } from "node:path"
import {
  listNodes,
  deleteChangesBefore,
  trimHealthChecks,
} from "#/lib/db"
import { exportNodeConfig } from "#/lib/configExport"
import { writeFileSync, mkdirSync } from "node:fs"

const INTERVAL_MS = 60 * 60 * 1000 // hourly
const RETENTION_DAYS = Number(process.env.HAPROXY_UI_RETENTION_DAYS ?? 30)
const HEALTH_KEEP = Number(process.env.HAPROXY_UI_HEALTH_KEEP ?? 720)
const BACKUP_DIR = process.env.HAPROXY_UI_BACKUP_DIR

let started = false

async function runOnce(): Promise<void> {
  // 1. trim per-node health check history
  trimHealthChecks(HEALTH_KEEP)

  // 2. purge config change history older than the retention window
  const nodes = listNodes()
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000
  let purged = 0
  for (const n of nodes) {
    purged += deleteChangesBefore(n.id, cutoff)
  }
  if (purged > 0) {
    console.log(`[maintenance] purged ${purged} change records older than ${RETENTION_DAYS}d`)
  }

  // 3. optional raw-config backups
  if (BACKUP_DIR) {
    const dir = resolve(BACKUP_DIR)
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 10)
    for (const n of nodes) {
      const result = await exportNodeConfig(n.id)
      if (!result.ok) continue
      const safeName = n.name.replace(/[^A-Za-z0-9_.-]/g, "_")
      writeFileSync(
        join(dir, `${safeName}-${stamp}.json`),
        JSON.stringify(result.bundle, null, 2),
      )
    }
    console.log(`[maintenance] wrote config backups to ${dir}`)
  }
}

/** Idempotently start the hourly maintenance loop (timers unref'd so they
 *  never keep a process or test run alive). */
export function startMaintenance(): void {
  if (started) return
  started = true
  // first pass shortly after boot, then hourly
  setTimeout(() => {
    runOnce().catch((e) => console.error("[maintenance] run failed:", e))
  }, 10_000).unref()
  setInterval(() => {
    runOnce().catch((e) => console.error("[maintenance] run failed:", e))
  }, INTERVAL_MS).unref()
  console.log(
    `[maintenance] scheduler started (retention=${RETENTION_DAYS}d, backups=${BACKUP_DIR ? "on" : "off"})`,
  )
}

// Auto-start when this module is loaded on the server side (dev + prod).
// Guarded for non-server contexts; unref'd timers keep tests harmless.
if (process.env.HAPROXY_UI_MAINTENANCE !== "off") {
  startMaintenance()
}
