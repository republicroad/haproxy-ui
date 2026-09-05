"use client"

import { useEffect, useState } from "react"
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
