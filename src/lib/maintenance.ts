import { join, resolve } from "node:path"
import {
  listNodes,
  deleteChangesBefore,
  insertMetricSamples,
  listLatestHealthChecks,
  purgeMetricSamples,
  trimHealthChecks,
} from "#/lib/db"
import { exportNodeConfig } from "#/lib/configExport"
import { proxyToNode } from "#/lib/dataplane/proxy"
import { writeFileSync, mkdirSync } from "node:fs"

const INTERVAL_MS = 60 * 60 * 1000 // hourly
const METRICS_INTERVAL_MS =
  Number(process.env.HAPROXY_UI_METRICS_INTERVAL ?? 300) * 1000 // default 5 min
const METRICS_KEEP_HOURS = Number(process.env.HAPROXY_UI_METRICS_KEEP ?? 24 * 30)
const RETENTION_DAYS = Number(process.env.HAPROXY_UI_RETENTION_DAYS ?? 30)
const HEALTH_KEEP = Number(process.env.HAPROXY_UI_HEALTH_KEEP ?? 720)
const BACKUP_DIR = process.env.HAPROXY_UI_BACKUP_DIR

let started = false

type NativeStat = {
  type?: string
  name?: string
  stats?: {
    scur?: number
    stot?: number
    req_rate?: number
    bin?: number
    bout?: number
    hrsp_2xx?: number
    hrsp_5xx?: number
    status?: string
  }
}

async function sampleMetrics(): Promise<void> {
  const nodes = listNodes()
  const upIds = new Set(
    listLatestHealthChecks().filter((c) => c.ok).map((c) => c.nodeId),
  )
  for (const n of nodes) {
    if (!upIds.has(n.id)) continue
    try {
      const res = await proxyToNode(
        n.id,
        new Request("http://internal/metrics-sample", { method: "GET" }),
        "services/haproxy/stats/native",
      )
      if (!res.ok) continue
      const parsed = JSON.parse(await res.text()) as { stats?: NativeStat[] }
      const ts = Date.now()
      const samples = (parsed.stats ?? [])
        .filter(
          (s) =>
            (s.type === "frontend" || s.type === "backend") &&
            s.name &&
            !s.name.startsWith("_"),
        )
        .map((s) => ({
          ts,
          objType: s.type!,
          objName: s.name!,
          scur: s.stats?.scur ?? null,
          stot: s.stats?.stot ?? null,
          reqRate: s.stats?.req_rate ?? null,
          bin: s.stats?.bin ?? null,
          bout: s.stats?.bout ?? null,
          hrsp2xx: s.stats?.hrsp_2xx ?? null,
          hrsp5xx: s.stats?.hrsp_5xx ?? null,
          status: s.stats?.status ?? null,
        }))
      if (samples.length > 0) insertMetricSamples(n.id, samples)
    } catch {
      // node unreachable - skip this round
    }
  }
  purgeMetricSamples(METRICS_KEEP_HOURS)
}

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

/** Idempotently start the maintenance loops (timers unref'd so they
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

  // metric sampling loop (independent cadence)
  setTimeout(() => {
    sampleMetrics().catch((e) => console.error("[metrics] sample failed:", e))
  }, 15_000).unref()
  setInterval(() => {
    sampleMetrics().catch((e) => console.error("[metrics] sample failed:", e))
  }, METRICS_INTERVAL_MS).unref()
  console.log(
    `[maintenance] metrics sampler started (interval=${METRICS_INTERVAL_MS / 1000}s, keep=${METRICS_KEEP_HOURS}h)`,
  )
}

// Auto-start when this module is loaded on the server side (dev + prod).
// Guarded for non-server contexts; unref'd timers keep tests harmless.
if (process.env.HAPROXY_UI_MAINTENANCE !== "off") {
  startMaintenance()
}
