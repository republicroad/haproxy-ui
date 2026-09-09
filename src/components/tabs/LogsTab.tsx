"use client"

import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Badge } from "#/components/reui/badge"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { Label } from "#/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select"
import type { Frontend } from "#/lib/types"
import { POLL } from "#/lib/poll"

type LogRow = {
  nodeId: string | null
  ts: number
  clientIp: string | null
  frontend: string | null
  backend: string | null
  server: string | null
  status: number | null
  bytesRead: number | null
  totalTimeMs: number | null
  method: string | null
  path: string | null
}

type ChangeRow = {
  id: string
  ts: number
  kind: string
  resource: string
  target: string
  parent: string | null
  actor: string | null
}

type LogStatsSummary = {
  stats: {
    total: number
    ok2xx: number
    err4xx: number
    err5xx: number
    avgTimeMs: number | null
  }
  series: { ts: number; total: number; errors: number }[]
  topClients: { clientIp: string; count: number }[]
  frontends: { frontend: string; count: number; errors: number }[]
}

/** Compact per-bucket request volume chart (green bars, red error slice). */
function TrendChart({ series }: { series: LogStatsSummary["series"] }) {
  if (series.length === 0) {
    return <p className="text-xs text-muted-foreground">No trend data yet.</p>
  }
  const max = Math.max(...series.map((s) => s.total), 1)
  return (
    <div className="flex h-24 items-end gap-[2px]" aria-label="request trend">
      {series.map((s) => {
        const h = Math.max(3, (s.total / max) * 100)
        const errH = s.errors > 0 ? Math.max(2, (s.errors / max) * 100) : 0
        return (
          <div
            key={s.ts}
            title={`${new Date(s.ts).toLocaleTimeString()} — ${s.total} requests (${s.errors} x 5xx)`}
            className="relative w-[6px] overflow-hidden rounded-sm bg-success/60"
            style={{ height: `${h}%` }}
          >
            {errH > 0 && (
              <div
                className="absolute bottom-0 w-full bg-destructive/80"
                style={{ height: `${(errH / h) * 100}%` }}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function StatChip({
  label,
  value,
  tone,
}: {
  label: string
  value: string | number
  tone?: "success" | "warning" | "destructive"
}) {
  const color =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : tone === "destructive"
          ? "text-destructive"
          : ""
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-xl font-bold ${color}`}>{value}</div>
    </div>
  )
}

/** Aggregated view (SQL-side): totals, trend, top clients, frontends. */
function LogsSummary({ nodeId }: { nodeId: string }) {
  const q = useQuery({
    queryKey: ["log-stats", nodeId],
    queryFn: async (): Promise<LogStatsSummary> => {
      const res = await fetch(`/api/logs/stats?node=${encodeURIComponent(nodeId)}&hours=24`)
      if (!res.ok) throw new Error("failed to load log stats")
      return res.json()
    },
    refetchInterval: POLL.STATS,
  })
  if (q.isLoading || q.isError) return null
  const { stats, series, topClients, frontends } = q.data!
  if (stats.total === 0) return null
  const errRate = stats.total > 0 ? ((stats.err4xx + stats.err5xx) / stats.total) * 100 : 0

  return (
    <div className="grid gap-3 md:grid-cols-3">
      <div className="space-y-2 md:col-span-2">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <StatChip label="Requests 24h" value={stats.total} />
          <StatChip label="2xx" value={stats.ok2xx} tone="success" />
          <StatChip label="4xx" value={stats.err4xx} tone="warning" />
          <StatChip label="5xx" value={stats.err5xx} tone="destructive" />
          <StatChip
            label="Avg ms"
            value={stats.avgTimeMs ?? "—"}
          />
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>Requests per 5 min (red = 5xx)</span>
            <span>{errRate.toFixed(1)}% 4xx/5xx</span>
          </div>
          <TrendChart series={series} />
        </div>
      </div>
      <div className="space-y-2">
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Top clients (24h)
          </div>
          {topClients.length === 0 ? (
            <p className="text-xs text-muted-foreground">—</p>
          ) : (
            <div className="space-y-0.5">
              {topClients.slice(0, 6).map((c) => (
                <div key={c.clientIp} className="flex justify-between text-xs">
                  <span className="font-mono">{c.clientIp}</span>
                  <span className="text-muted-foreground">{c.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Frontends (24h)
          </div>
          {frontends.length === 0 ? (
            <p className="text-xs text-muted-foreground">—</p>
          ) : (
            <div className="space-y-0.5">
              {frontends.slice(0, 6).map((f) => (
                <div key={f.frontend} className="flex justify-between text-xs">
                  <span>{f.frontend}</span>
                  <span className="text-muted-foreground">
                    {f.count}
                    {f.errors > 0 ? ` · ${f.errors} err` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: number | null }) {
  if (!status) return <span className="text-muted-foreground">—</span>
  const v =
    status < 300 ? "success" : status < 400 ? "secondary" : status < 500 ? "warning" : "destructive"
  return <Badge variant={v}>{status}</Badge>
}

function fmtBytes(n: number | null): string {
  if (n == null) return "—"
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/**
 * Request explorer over the UDP-syslog ingested access logs
 * (HAPROXY_UI_LOG_PORT). Filters by frontend, status class and path.
 * Clicking a row shows configuration changes from the surrounding time
 * window (correlation) and a jump to the serving backend.
 */
export function LogsTab({
  nodeId,
  frontends,
  onNavigate,
}: {
  nodeId: string
  frontends: Frontend[]
  onNavigate?: (tab: string) => void
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const [frontend, setFrontend] = useState<string>("all")
  const [statusClass, setStatusClass] = useState<string>("all")
  const [pathFilter, setPathFilter] = useState("")

  const q = useQuery({
    queryKey: ["logs", nodeId, frontend, statusClass, pathFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ node: nodeId, limit: "200" })
      if (frontend !== "all") params.set("frontend", frontend)
      if (statusClass !== "all") params.set("status", statusClass)
      if (pathFilter.trim()) params.set("q", pathFilter.trim())
      const res = await fetch(`/api/logs?${params}`)
      if (!res.ok) throw new Error("failed to load logs")
      return (await res.json()) as LogRow[]
    },
    enabled: mounted,
    refetchInterval: POLL.STATS,
  })
  const rows = q.data ?? []
  const [expanded, setExpanded] = useState<LogRow | null>(null)
  const WINDOW_MS = 30 * 60_000

  const changesQ = useQuery({
    queryKey: ["log-drill", nodeId, expanded?.ts],
    queryFn: async (): Promise<ChangeRow[]> => {
      if (!expanded) return []
      const params = new URLSearchParams({
        since: String(expanded.ts - WINDOW_MS),
        until: String(expanded.ts + WINDOW_MS),
      })
      const res = await fetch(`/api/nodes/${nodeId}/changes?${params}`)
      if (!res.ok) throw new Error("failed to load changes")
      const j = await res.json()
      return j.changes ?? []
    },
    enabled: Boolean(expanded),
  })

  return (
    <div className="space-y-3">
      <LogsSummary nodeId={nodeId} />
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Frontend</Label>
          <Select value={frontend} onValueChange={(v) => setFrontend(v ?? "all")}>
            <SelectTrigger className="w-[180px]" aria-label="log frontend filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All frontends</SelectItem>
              {frontends.map((f) => (
                <SelectItem key={f.name} value={f.name}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Status</Label>
          <Select value={statusClass} onValueChange={(v) => setStatusClass(v ?? "all")}>
            <SelectTrigger className="w-[130px]" aria-label="log status filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="2">2xx</SelectItem>
              <SelectItem value="4">4xx</SelectItem>
              <SelectItem value="5">5xx</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Path</Label>
          <Input
            placeholder="path contains…"
            value={pathFilter}
            onChange={(e) => setPathFilter(e.target.value)}
            className="w-56"
            aria-label="log path filter"
          />
        </div>
        <Button variant="outline" size="sm" onClick={() => q.refetch()}>
          Refresh
        </Button>
      </div>

      {q.isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : q.isError ? (
        <p className="text-destructive">Cannot load logs: {(q.error as Error).message}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No access-log records yet. Enable ingestion by setting
          HAPROXY_UI_LOG_PORT and pointing HAProxy's <code>log</code>{" "}
          directive at this host (UDP).
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2">Client</th>
                <th className="px-3 py-2">Frontend</th>
                <th className="px-3 py-2">Backend/Server</th>
                <th className="px-3 py-2">Request</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Bytes</th>
                <th className="px-3 py-2">Time (ms)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={i}
                  className={
                    "cursor-pointer border-t border-border hover:bg-muted/40" +
                    (expanded === r ? " bg-muted/60" : "")
                  }
                  onClick={() => setExpanded(expanded === r ? null : r)}
                  title="Click for configuration changes around this request"
                >
                  <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                    {new Date(r.ts).toLocaleTimeString()}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.clientIp ?? "—"}</td>
                  <td className="px-3 py-2">{r.frontend ?? "—"}</td>
                  <td className="px-3 py-2">
                    {r.backend ?? "—"}
                    {r.server ? `/${r.server}` : ""}
                  </td>
                  <td className="max-w-[320px] truncate px-3 py-2 font-mono text-xs" title={`${r.method ?? ""} ${r.path ?? ""}`}>
                    {r.method ?? ""} {r.path ?? ""}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{fmtBytes(r.bytesRead)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{r.totalTimeMs ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {expanded && (
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium">
              Changes within ±30 min of{" "}
              {new Date(expanded.ts).toLocaleTimeString()}{" "}
              <span className="font-mono text-xs text-muted-foreground">
                ({expanded.method} {expanded.path} → {expanded.backend ?? "?"})
              </span>
            </div>
            <div className="flex gap-2">
              {expanded.backend && onNavigate && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onNavigate("backends")}
                >
                  Open backends
                </Button>
              )}
              <Button size="xs" variant="ghost" onClick={() => setExpanded(null)}>
                Close
              </Button>
            </div>
          </div>
          {changesQ.isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
          {changesQ.data && changesQ.data.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No configuration changes recorded in this window — the error is
              unlikely to be config-related.
            </p>
          )}
          {(changesQ.data ?? []).map((c) => (
            <div key={c.id} className="border-t border-border py-1 text-xs first:border-t-0">
              <span className="text-muted-foreground">{new Date(c.ts).toLocaleString()}</span>
              {" · "}
              <span className="font-medium">
                {c.kind} {c.resource} "{c.target}"
              </span>
              {c.parent ? <span className="text-muted-foreground"> in {c.parent}</span> : null}
              {c.actor ? <span className="text-muted-foreground"> by {c.actor}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
