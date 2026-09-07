import { createFileRoute } from "@tanstack/react-router"
import { publish } from "#/lib/events"
import {
  getAlertSettings,
  getAlertState,
  getSmtpSettings,
  insertHealthCheck,
  lastHealthCheckTs,
  listHealthChecks,
  listLatestHealthChecks,
  listNodes,
  setAlertState,
  trimHealthChecks,
  updateNode,
} from "#/lib/db"
import { proxyToNode } from "#/lib/dataplane/proxy"
import { sendMail } from "#/lib/smtp"

const ALERT_COOLDOWN_MS = 5 * 60_000

type AlertPayload = {
  event: "node_down" | "node_recovered"
  node: { id: string; name: string }
  status: "up" | "down"
  error?: string | null
  ts: number
}

async function fireWebhook(payload: AlertPayload, webhookUrl: string): Promise<boolean> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, text: `HAProxy UI: ${payload.node.name} is ${payload.status}` }),
      signal: AbortSignal.timeout(5000),
    })
    return res.ok
  } catch {
    return false
  }
}

async function fireEmail(payload: AlertPayload): Promise<boolean> {
  const s = getSmtpSettings()
  if (!s.enabled || !s.host || s.toAddrs.length === 0) return false
  try {
    await sendMail(
      {
        host: s.host,
        port: s.port,
        secure: s.secure,
        username: s.username || undefined,
        password: s.password || undefined,
        from: s.fromAddr || "haproxy-ui@localhost",
        to: s.toAddrs,
      },
      `[HAProxy UI] ${payload.node.name} is ${payload.status.toUpperCase()}`,
      [
        `Node: ${payload.node.name}`,
        `Event: ${payload.event}`,
        `Status: ${payload.status}`,
        payload.error ? `Error: ${payload.error}` : null,
        `Time: ${new Date(payload.ts).toISOString()}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    return true
  } catch {
    return false
  }
}

async function fireAlert(payload: AlertPayload): Promise<void> {
  const { webhookUrl, enabled } = getAlertSettings()
  const smtp = getSmtpSettings()
  const webhookOn = enabled && Boolean(webhookUrl)
  const emailOn = smtp.enabled && Boolean(smtp.host) && smtp.toAddrs.length > 0
  if (!webhookOn && !emailOn) return
  const state = getAlertState(payload.node.id)
  const isDown = payload.event === "node_down"
  // only alert on transitions
  if (state.lastOk !== null && state.lastOk === !isDown) return
  if (Date.now() - state.lastAlertTs < ALERT_COOLDOWN_MS) return

  let delivered = false
  if (webhookOn) delivered = (await fireWebhook(payload, webhookUrl)) || delivered
  if (emailOn) delivered = (await fireEmail(payload)) || delivered
  if (delivered) setAlertState(payload.node.id, !isDown, Date.now())
}

const MIN_INTERVAL_MS = 20_000
const HISTORY_POINTS = 40

async function probeNode(
  nodeId: string,
): Promise<{ ok: boolean; version: string | null; latencyMs: number | null; error: string | null }> {
  const started = Date.now()
  try {
    const res = await proxyToNode(
      nodeId,
      new Request("http://internal/health", { method: "GET" }),
      "services/haproxy/runtime/info",
    )
    const latencyMs = Date.now() - started
    if (!res.ok) {
      return { ok: false, version: null, latencyMs, error: `HTTP ${res.status}` }
    }
    const info = (await res.json()) as { version?: string }
    return { ok: true, version: info.version ?? null, latencyMs, error: null }
  } catch (e) {
    return { ok: false, version: null, latencyMs: Date.now() - started, error: (e as Error).message }
  }
}

async function serverStates(
  nodeId: string,
): Promise<{ backend: string; server: string; state: string }[]> {
  const out: { backend: string; server: string; state: string }[] = []
  // The backends list is read from the configuration endpoints — real
  // dataplaneapi has no GET /runtime/backends collection. It also does not
  // embed servers there, but the names are enough to query runtime states.
  const res = await proxyToNode(
    nodeId,
    new Request("http://internal/stats", { method: "GET" }),
    "services/haproxy/configuration/backends",
  )
  if (!res.ok) return out
  const text = await res.text()
  let backends: { name?: string }[] = []
  try {
    const parsed = JSON.parse(text) as unknown
    backends = Array.isArray(parsed)
      ? (parsed as { name?: string }[])
      : ((parsed as { data?: { name?: string }[] }).data ?? [])
  } catch {
    return out
  }
  await Promise.all(
    backends.slice(0, 50).map(async (b) => {
      if (!b.name || b.name.startsWith("_")) return
      try {
        const sres = await proxyToNode(
          nodeId,
          new Request("http://internal/servers", { method: "GET" }),
          `services/haproxy/runtime/backends/${encodeURIComponent(b.name)}/servers`,
        )
        if (!sres.ok) return
        const stext = await sres.text()
        const sparsed = JSON.parse(stext) as unknown
        const servers = Array.isArray(sparsed)
          ? sparsed
          : ((sparsed as { data?: unknown[] }).data ?? [])
        for (const s of servers as { name?: string; operational_state?: string; admin_state?: string }[]) {
          if (!s.name) continue
          out.push({
            backend: b.name,
            server: s.name,
            state:
              s.operational_state ??
              (s.admin_state === "ready" ? "UP" : (s.admin_state ?? "unknown")),
          })
        }
      } catch {
        // per-backend failures don't break the summary
      }
    }),
  )
  return out
}

export const Route = createFileRoute("/api/health/summary")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const force = url.searchParams.get("refresh") === "1"
        const nodes = listNodes()
        const latest = new Map(listLatestHealthChecks().map((c) => [c.nodeId, c]))
        trimHealthChecks(720)

        for (const n of nodes) {
          const stale = Date.now() - lastHealthCheckTs(n.id) > MIN_INTERVAL_MS
          if (!force && !stale) continue
          const probe = await probeNode(n.id)
          const ts = Date.now()
          insertHealthCheck({
            nodeId: n.id,
            ts,
            ok: probe.ok,
            version: probe.version,
            latencyMs: probe.latencyMs,
            error: probe.error,
          })
          updateNode(n.id, {
            status: probe.ok ? "up" : "down",
            haproxyVersion: probe.version ?? undefined,
            lastSeen: probe.ok ? ts : undefined,
          })
          latest.set(n.id, {
            nodeId: n.id,
            ts,
            ok: probe.ok,
            version: probe.version,
            latencyMs: probe.latencyMs,
            error: probe.error,
          })
          // state-transition alerting (up->down and recovery), webhook-gated
          const prev = getAlertState(n.id)
          const flipped = (prev.lastOk === true && !probe.ok) || (prev.lastOk === false && probe.ok)
          if (flipped) {
            publish({
              type: "node_status",
              nodeId: n.id,
              status: probe.ok ? "up" : "down",
            })
          }
          if (prev.lastOk === true && !probe.ok) {
            await fireAlert({
              event: "node_down",
              node: { id: n.id, name: n.name },
              status: "down",
              error: probe.error,
              ts,
            })
          } else if (prev.lastOk === false && probe.ok) {
            await fireAlert({
              event: "node_recovered",
              node: { id: n.id, name: n.name },
              status: "up",
              error: null,
              ts,
            })
          } else {
            setAlertState(n.id, probe.ok)
          }
        }

        const upIds = nodes.filter((n) => latest.get(n.id)?.ok).map((n) => n.id)
        const serverStateLists = await Promise.all(
          upIds.map((id) => serverStates(id).catch(() => [])),
        )
        const statesByNode = new Map(
          upIds.map((id, i) => [id, serverStateLists[i]] as const),
        )

        const summary = nodes.map((n) => {
          const check = latest.get(n.id)
          const states = statesByNode.get(n.id) ?? []
          return {
            id: n.id,
            name: n.name,
            apiUrl: n.apiUrl,
            status: check ? (check.ok ? "up" : "down") : n.status === "unknown" ? "unknown" : "down",
            version: check?.version ?? n.haproxyVersion,
            latencyMs: check?.latencyMs ?? null,
            lastCheckTs: check?.ts ?? null,
            error: check?.error ?? null,
            history: listHealthChecks(n.id, HISTORY_POINTS).reverse(),
            serversDown: states.filter((s) => s.state !== "UP").length,
            serversTotal: states.length,
            serverStates: states,
          }
        })

        return Response.json({
          checkedAt: Date.now(),
          nodes: summary,
          totals: {
            up: summary.filter((s) => s.status === "up").length,
            down: summary.filter((s) => s.status === "down").length,
            unknown: summary.filter((s) => s.status === "unknown").length,
            serversDown: summary.reduce((acc, s) => acc + s.serversDown, 0),
          },
        })
      },
    },
  },
})
