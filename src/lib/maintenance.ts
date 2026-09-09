import { join, resolve } from "node:path"
import {
  getAlertSettings,
  getAlertState,
  listNodes,
  deleteChangesBefore,
  insertMetricSamples,
  listLatestHealthChecks,
  logWindowStats,
  purgeMetricSamples,
  purgeLogRecords,
  setAlertState,
  trimAlertHistory,
  trimHealthChecks,
} from "#/lib/db"
import { exportNodeConfig } from "#/lib/configExport"
import { proxyToNode } from "#/lib/dataplane/proxy"
import { LOG_KEEP_HOURS, startLogIngest } from "#/lib/logIngest"
import { alertChannelsEnabled, notifyEmail, notifyWebhook } from "#/lib/alertChannels"
import { expiringCerts, listCertsWithExpiry } from "#/lib/certCheck"
import { DEFAULT_THRESHOLDS, detectAnomalies, type AnomalyKind } from "#/lib/anomaly"
import { writeFileSync, mkdirSync } from "node:fs"

const INTERVAL_MS = 60 * 60 * 1000 // hourly
const METRICS_INTERVAL_MS =
  Number(process.env.HAPROXY_UI_METRICS_INTERVAL ?? 300) * 1000 // default 5 min
const METRICS_KEEP_HOURS = Number(process.env.HAPROXY_UI_METRICS_KEEP ?? 24 * 30)
const RETENTION_DAYS = Number(process.env.HAPROXY_UI_RETENTION_DAYS ?? 30)
const HEALTH_KEEP = Number(process.env.HAPROXY_UI_HEALTH_KEEP ?? 720)
const BACKUP_DIR = process.env.HAPROXY_UI_BACKUP_DIR
const CERT_WARN_DAYS = Number(process.env.HAPROXY_UI_CERT_WARN_DAYS ?? 30)
const CERT_CHECK_INTERVAL_MS = 24 * 3_600_000 // scan certificates daily
const ANOMALY_INTERVAL_MS =
  Number(process.env.HAPROXY_UI_ANOMALY_INTERVAL ?? 300) * 1000 // default 5 min
// env values are fallbacks; per-deployment overrides live in alert_settings
const ANOMALY_ENV_FALLBACK = {
  err5xxPct: Number(process.env.HAPROXY_UI_ANOMALY_5XX_PCT ?? DEFAULT_THRESHOLDS.err5xxPct),
  rateMult: Number(process.env.HAPROXY_UI_ANOMALY_RATE_MULT ?? DEFAULT_THRESHOLDS.rateMult),
  latencyMs: Number(process.env.HAPROXY_UI_ANOMALY_LATENCY_MS ?? DEFAULT_THRESHOLDS.latencyMs),
  minRequests: Number(process.env.HAPROXY_UI_ANOMALY_MIN_REQUESTS ?? DEFAULT_THRESHOLDS.minRequests),
  cooldownMin: Number(process.env.HAPROXY_UI_ANOMALY_COOLDOWN_MIN ?? 15),
}

let started = false
let lastCertCheckTs = 0

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

/**
 * Daily certificate expiry scan. Repeats an alert per certificate at most
 * once a day (alert_state keyed by a synthetic cert: key) until the cert
 * is renewed or removed.
 */
async function checkCertExpiry(upNodeIds: string[]): Promise<void> {
  if (Date.now() - lastCertCheckTs < CERT_CHECK_INTERVAL_MS) return
  lastCertCheckTs = Date.now()
  if (!alertChannelsEnabled()) return
  const nodeNames = new Map(listNodes().map((n) => [n.id, n.name]))
  for (const nodeId of upNodeIds) {
    let certs
    try {
      certs = await listCertsWithExpiry(nodeId)
    } catch {
      continue
    }
    for (const cert of expiringCerts(certs, CERT_WARN_DAYS)) {
      const key = `cert:${nodeId}:${cert.name}`
      const state = getAlertState(key)
      if (Date.now() - state.lastAlertTs < CERT_CHECK_INTERVAL_MS) continue
      const label = cert.expired
        ? `expired ${-cert.daysLeft}d ago`
        : `expires in ${cert.daysLeft}d`
      const node = nodeNames.get(nodeId) ?? nodeId
      const text = `HAProxy UI: certificate "${cert.name}" on ${node} ${label}`
      const body = [
        `Node: ${node}`,
        `Certificate: ${cert.name}`,
        `Subject: ${cert.subject ?? "?"}`,
        `Status: ${label}`,
        `Valid to: ${cert.validTo ?? "?"}`,
      ].join("\n")
      const delivered =
        (await notifyWebhook(
          text,
          {
            event: cert.expired ? "cert_expired" : "cert_expiring",
            node: { id: nodeId, name: node },
            certificate: cert.name,
            daysLeft: cert.daysLeft,
            ts: Date.now(),
          },
          { kind: cert.expired ? "cert_expired" : "cert_expiring", nodeId },
        )) ||
        (await notifyEmail(text, body, {
          kind: cert.expired ? "cert_expired" : "cert_expiring",
          nodeId,
        }))
      if (delivered) setAlertState(key, true, Date.now())
    }
  }
}

/**
 * Rolling-window access-log anomaly detection (5xx share, traffic spike,
 * latency spike). Per (kind, node) cooldown via the alert_state table.
 */
async function checkAnomalies(): Promise<void> {
  if (!alertChannelsEnabled()) return
  const settings = getAlertSettings()
  const thresholds = {
    err5xxPct: settings.anom5xxPct ?? ANOMALY_ENV_FALLBACK.err5xxPct,
    rateMult: settings.anomRateMult ?? ANOMALY_ENV_FALLBACK.rateMult,
    latencyMs: settings.anomLatencyMs ?? ANOMALY_ENV_FALLBACK.latencyMs,
    minRequests: settings.anomMinRequests ?? ANOMALY_ENV_FALLBACK.minRequests,
  }
  const cooldownMs =
    (settings.anomCooldownMin ?? ANOMALY_ENV_FALLBACK.cooldownMin) * 60_000
  const now = Date.now()
  for (const node of listNodes()) {
    const current = logWindowStats(node.id, now - 5 * 60_000, now)
    const baseline = logWindowStats(node.id, now - 35 * 60_000, now - 5 * 60_000)
    for (const kind of detectAnomalies(current, baseline, thresholds)) {
      const key = `anom:${kind}:${node.id}`
      const state = getAlertState(key)
      if (now - state.lastAlertTs < cooldownMs) continue
      const label = {
        err5xx: `5xx share ${(current.err5xx / Math.max(current.total, 1) * 100).toFixed(0)}% in the last 5 min`,
        rate: `traffic spike: ${current.total} requests in 5 min (baseline ~${Math.round(baseline.total / 6)}/5min)`,
        latency: `latency spike: avg ${current.avgTimeMs}ms (baseline ${baseline.avgTimeMs ?? "?"}ms)`,
      }[kind as AnomalyKind]
      const text = `HAProxy UI: ${node.name} — ${label}`
      const delivered =
        (await notifyWebhook(
          text,
          {
            event: `anomaly_${kind}`,
            node: { id: node.id, name: node.name },
            current,
            baseline,
            ts: now,
          },
          { kind: `anomaly_${kind}`, nodeId: node.id },
        )) ||
        (await notifyEmail(
          `[HAProxy UI] ${node.name}: ${kind} anomaly`,
          [`Node: ${node.name}`, `Anomaly: ${kind}`, `Detail: ${label}`, `Window: ${new Date(now - 5 * 60_000).toLocaleTimeString()} - ${new Date(now).toLocaleTimeString()}`].join("\n"),
          { kind: `anomaly_${kind}`, nodeId: node.id },
        ))
      if (delivered) setAlertState(key, true, now)
    }
  }
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

  // 2b. purge ingested access-log records
  const purgedLogs = purgeLogRecords(LOG_KEEP_HOURS)
  if (purgedLogs > 0) {
    console.log(`[maintenance] purged ${purgedLogs} access-log records older than ${LOG_KEEP_HOURS}h`)
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

  // 4. daily certificate expiry scan (throttled internally, alert-gated)
  const upIds = listLatestHealthChecks().filter((c) => c.ok).map((c) => c.nodeId)
  await checkCertExpiry(upIds).catch((e) =>
    console.error("[maintenance] cert expiry check failed:", e),
  )

  // 5. notification history housekeeping
  trimAlertHistory(200)
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

  // UDP access-log receiver (no-op unless HAPROXY_UI_LOG_PORT is set)
  startLogIngest()

  // anomaly detection loop (needs ingested logs; cadence = window length)
  setInterval(() => {
    checkAnomalies().catch((e) => console.error("[anomaly] check failed:", e))
  }, ANOMALY_INTERVAL_MS).unref()
  console.log(
    `[maintenance] anomaly detector started (interval=${ANOMALY_INTERVAL_MS / 1000}s; thresholds from alert settings)`,
  )
}

// Auto-start when this module is loaded on the server side (dev + prod).
// Guarded for non-server contexts; unref'd timers keep tests harmless.
if (process.env.HAPROXY_UI_MAINTENANCE !== "off") {
  startMaintenance()
}
