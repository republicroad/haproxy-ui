import { createSocket, type RemoteInfo } from "node:dgram"
import { listNodes, insertLogRecords, type LogRecord } from "#/lib/db"

/**
 * Access-log ingestion: a UDP syslog receiver for HAProxy log output.
 *
 * Point HAProxy at it with e.g. `log 127.0.0.1:1514 local0` and the UI's
 * "logs" tab gets a filterable request explorer. Payloads that don't look
 * like HAProxy HTTP logs are counted and dropped.
 *
 * Configuration:
 * - HAPROXY_UI_LOG_PORT   UDP port to bind (unset = ingestion disabled)
 * - HAPROXY_UI_LOG_SAMPLE sampling percent 1-100 (default 100)
 * - HAPROXY_UI_LOG_KEEP   retention hours (default 24, purged hourly)
 */

export const LOG_KEEP_HOURS = Number(process.env.HAPROXY_UI_LOG_KEEP ?? 24)
const SAMPLE_PERCENT = Math.min(100, Math.max(1, Number(process.env.HAPROXY_UI_LOG_SAMPLE ?? 100)))

/** Strip an RFC3164 syslog header (`<pri>Mmm d hh:mm:ss host tag[pid]:`). */
export function stripSyslogHeader(line: string): string {
  const m = line.match(/^(?:<\d+>)?\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\S+\s+[^:]+:\s+(.*)$/)
  return m ? m[1] : line
}

/**
 * Parse one HAProxy HTTP log line (the default `log-format` after the
 * syslog prefix). Returns null for anything that doesn't match — TCP-mode
 * logs, health-check noise, empty captures.
 */
export function parseHaProxyLogLine(raw: string): Omit<LogRecord, "nodeId" | "ts"> | null {
  const line = stripSyslogHeader(raw.trim())
  const m = line.match(
    /^(\S+?)(?::\d+)?\s+\[[^\]]+\]\s+(\S+)\s+(?:([^\s/]+)\/([^\s]+)|(\S+)\s+NOSRV)\s+([\d.]+(?:\/[\d.]+)*)\s+(\d{3})\s+(\d+|-)\s+\S+\s+\S+\s+\S+\s.*?"([^"]*)"\s*$/,
  )
  if (!m) return null
  const [, clientIp, frontend, beA, srvA, beB, timers, statusStr, bytesStr, request] = m
  if (statusStr === "0" && request === "") return null
  const backend = beA ?? beB
  const timerParts = timers.split("/")
  const totalTimeMs = Math.round(Number(timerParts[timerParts.length - 1])) || 0
  const [method, path] = request.split(" ")
  return {
    clientIp,
    frontend,
    backend: backend && backend !== "-" ? backend : null,
    server: srvA && srvA !== "-" && srvA !== "NOSRV" ? srvA : null,
    status: Number(statusStr) || null,
    bytesRead: bytesStr === "-" ? null : Number(bytesStr),
    totalTimeMs,
    method: method ?? null,
    path: path ?? null,
  }
}

/** Best-effort attribution: match the sender IP to a registered node's apiUrl host. */
function nodeForSender(senderIp: string): string | null {
  try {
    for (const n of listNodes()) {
      const host = new URL(n.apiUrl).hostname
      if (host === senderIp) return n.id
    }
  } catch {
    // ignore — attribution is best-effort
  }
  return null
}

let started = false

/** Idempotently bind the UDP receiver (no-op when HAPROXY_UI_LOG_PORT is unset). */
export function startLogIngest(): void {
  const port = Number(process.env.HAPROXY_UI_LOG_PORT ?? 0)
  if (!port || started) return
  started = true
  const socket = createSocket("udp4")
  const batch: LogRecord[] = []
  let flushTimer: NodeJS.Timeout | null = null

  const flush = () => {
    if (batch.length > 0) {
      insertLogRecords(batch.splice(0))
    }
    flushTimer = null
  }

  socket.on("message", (buf: Buffer, rinfo: RemoteInfo) => {
    for (const raw of buf.toString().split("\n")) {
      if (!raw.trim()) continue
      if (SAMPLE_PERCENT < 100 && Math.random() * 100 >= SAMPLE_PERCENT) continue
      const parsed = parseHaProxyLogLine(raw)
      if (!parsed) continue
      batch.push({ ...parsed, nodeId: nodeForSender(rinfo.address), ts: Date.now() })
    }
    if (batch.length >= 100) {
      flush()
    } else if (!flushTimer) {
      flushTimer = setTimeout(flush, 1_000).unref()
    }
  })
  socket.on("error", () => {
    // keep the receiver alive; bind errors are logged once below
  })
  socket.bind(port, () => {
    console.log(`[logs] syslog receiver listening on udp/${port} (sample=${SAMPLE_PERCENT}%, keep=${LOG_KEEP_HOURS}h)`)
  })
}
