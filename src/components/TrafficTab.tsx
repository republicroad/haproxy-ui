"use client"

import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Badge } from "#/components/reui/badge"
import { Button } from "#/components/ui/button"
import { GridSearchInput } from "#/components/GridSearchInput"
import { dpGet } from "#/lib/dataplane/client"
import { POLL } from "#/lib/poll"

type NativeStatStats = {
  scur?: number
  stot?: number
  req_rate?: number
  bin?: number
  bout?: number
  hrsp_1xx?: number
  hrsp_2xx?: number
  hrsp_4xx?: number
  hrsp_5xx?: number
  weight?: number
  status?: string
}

type NativeStat = {
  type: "frontend" | "backend" | "server"
  name: string
  backend_name?: string
  stats?: NativeStatStats
}

function fmtBytes(n?: number): string {
  if (n == null) return "—"
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function StatusBadge({ status }: { status?: string }) {
  if (!status) return <span className="text-muted-foreground">—</span>
  const up = status.startsWith("UP") || status === "OPEN"
  const down = status.startsWith("DOWN")
  return (
    <Badge variant={up ? "success" : down ? "destructive" : "secondary"}>
      {status}
    </Badge>
  )
}

type TrafficHistorySample = {
  ts: number
  objType: string
  objName: string
  stot: number | null
  reqRate: number | null
  bin: number | null
  bout: number | null
}

/** Simple SVG line chart for a single series over time. */
function TrendChart({
  series,
  label,
  color,
}: {
  series: { ts: number; value: number }[]
  label: string
  color: string
}) {
  if (series.length < 2) {
    return (
      <div className="flex h-24 items-center justify-center rounded-lg border border-border text-xs text-muted-foreground">
        {label}: not enough samples yet (collected every 5 minutes)
      </div>
    )
  }
  const w = 560
  const h = 96
  const pad = 4
  const values = series.map((p) => p.value)
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const range = max - min || 1
  const t0 = series[0].ts
  const t1 = series[series.length - 1].ts
  const tRange = t1 - t0 || 1
  const pts = series.map((p) => {
    const x = pad + ((p.ts - t0) / tRange) * (w - 2 * pad)
    const y = h - pad - ((p.value - min) / range) * (h - 2 * pad)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const last = values[values.length - 1]
  return (
    <div className="rounded-lg border border-border p-2">
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          now {last.toLocaleString()} · {series.length} samples / 24h
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label={label}>
        <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
    </div>
  )
}

/** 24h trend charts built from the metric_samples table. */
function TrafficTrends({ nodeId, focusName }: { nodeId: string; focusName: string }) {
  const q = useQuery({
    queryKey: ["traffic-history", nodeId, focusName],
    queryFn: async (): Promise<TrafficHistorySample[]> => {
      const qs = focusName ? `&name=${encodeURIComponent(focusName)}` : ""
      const res = await fetch(`/api/nodes/${nodeId}/metrics?hours=24&type=frontend${qs}`)
      if (!res.ok) throw new Error("failed to load metric history")
      const j = (await res.json()) as { samples: TrafficHistorySample[] }
      return j.samples
    },
    enabled: Boolean(nodeId),
    refetchInterval: 60_000,
  })

  const samples = q.data ?? []
  // aggregate across frontends per timestamp when no focus object
  const rateSeries = useMemo(() => {
    const byTs = new Map<number, number>()
    for (const s of samples) {
      if (s.reqRate == null) continue
      byTs.set(s.ts, (byTs.get(s.ts) ?? 0) + s.reqRate)
    }
    return [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([ts, value]) => ({ ts, value }))
  }, [samples])

  const binSeries = useMemo(() => {
    const byTs = new Map<number, number>()
    for (const s of samples) {
      if (s.bin == null) continue
      byTs.set(s.ts, (byTs.get(s.ts) ?? 0) + s.bin)
    }
    return [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([ts, value]) => ({ ts, value }))
  }, [samples])

  if (q.isError) return null

  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
      <TrendChart series={rateSeries} label="Requests/s (24h, all frontends)" color="#3b82f6" />
      <TrendChart series={binSeries} label="Bytes in (24h, all frontends)" color="#10b981" />
    </div>
  )
}

function TrafficTable({
  title,
  rows,
  showRates,
}: {
  title: string
  rows: NativeStat[]
  showRates: boolean
}) {
  return (
    <div className="space-y-1">
      <h4 className="text-sm font-semibold">{title}</h4>
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Status</th>
              {showRates && <th className="px-3 py-2">Req/s</th>}
              <th className="px-3 py-2">Sessions</th>
              <th className="px-3 py-2">Total</th>
              <th className="px-3 py-2">In</th>
              <th className="px-3 py-2">Out</th>
              <th className="px-3 py-2">2xx / 4xx / 5xx</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-3 text-muted-foreground">
                  None
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={`${r.type}-${r.backend_name ?? ""}-${r.name}`} className="border-t border-border">
                <td className="px-3 py-2 font-medium">
                  {r.name}
                  {r.type === "server" && r.backend_name && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      in {r.backend_name}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge status={r.stats?.status} />
                </td>
                {showRates && (
                  <td className="px-3 py-2">{r.stats?.req_rate ?? "—"}</td>
                )}
                <td className="px-3 py-2">{r.stats?.scur ?? "—"}</td>
                <td className="px-3 py-2">{r.stats?.stot ?? "—"}</td>
                <td className="px-3 py-2">{fmtBytes(r.stats?.bin)}</td>
                <td className="px-3 py-2">{fmtBytes(r.stats?.bout)}</td>
                <td className="px-3 py-2">
                  {r.stats?.hrsp_2xx ?? "—"} / {r.stats?.hrsp_4xx ?? "—"} /{" "}
                  {r.stats?.hrsp_5xx ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function TrafficTab({ nodeId }: { nodeId: string }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const [filter, setFilter] = useState("")

  const q = useQuery({
    queryKey: ["native-stats", nodeId],
    queryFn: () =>
      dpGet<{ stats?: NativeStat[] }>(nodeId, "services/haproxy/stats/native"),
    enabled: mounted,
    refetchInterval: POLL.TRAFFIC,
  })

  const all = (q.data?.stats ?? []).filter((s) =>
    filter ? s.name.toLowerCase().includes(filter.toLowerCase()) : true,
  )
  const frontends = all.filter((s) => s.type === "frontend")
  const backends = all.filter((s) => s.type === "backend")
  const servers = all.filter((s) => s.type === "server")

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <GridSearchInput
          value={filter}
          onChange={setFilter}
          placeholder="Filter by name…"
        />
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">refreshes every 30s</span>
          <Button size="xs" variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
            Refresh
          </Button>
        </div>
      </div>

      <TrafficTrends nodeId={nodeId} focusName={filter} />

      {q.isLoading && <p className="text-muted-foreground">Loading stats…</p>}
      {q.isError && (
        <p className="text-destructive">
          Cannot read stats: {(q.error as Error).message}
        </p>
      )}

      {q.data && (
        <>
          <TrafficTable title="Frontends" rows={frontends} showRates />
          <TrafficTable title="Backends" rows={backends} showRates={false} />
          <TrafficTable title="Servers" rows={servers} showRates />
        </>
      )}
    </div>
  )
}
