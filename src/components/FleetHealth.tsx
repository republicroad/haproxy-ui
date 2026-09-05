"use client"

import { useQuery } from "@tanstack/react-query"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { Badge } from "#/components/reui/badge"
import { Button } from "#/components/ui/button"

type HealthPoint = {
  ts: number
  ok: boolean
  latencyMs: number | null
  error: string | null
}

type SummaryNode = {
  id: string
  name: string
  status: string
  version: string | null
  latencyMs: number | null
  lastCheckTs: number | null
  error: string | null
  history: HealthPoint[]
  serversDown: number
  serversTotal: number
}

type HealthSummary = {
  checkedAt: number
  nodes: SummaryNode[]
  totals: { up: number; down: number; unknown: number; serversDown: number }
}

function LatencyBars({ history }: { history: HealthPoint[] }) {
  if (history.length === 0) {
    return <span className="text-xs text-muted-foreground">no data</span>
  }
  const points = history.slice(-30)
  const maxLatency = Math.max(...points.map((p) => p.latencyMs ?? 0), 1)
  return (
    <div className="flex h-8 items-end gap-[2px]" aria-label="latency history">
      {points.map((p) => (
        <div
          key={p.ts}
          title={
            p.ok
              ? `${new Date(p.ts).toLocaleTimeString()} — ${p.latencyMs ?? "?"} ms`
              : `${new Date(p.ts).toLocaleTimeString()} — ${p.error ?? "down"}`
          }
          className={[
            "w-[5px] rounded-sm",
            p.ok ? "bg-success/70" : "bg-destructive/80",
          ].join(" ")}
          style={{
            height: `${p.ok ? Math.max(15, ((p.latencyMs ?? 0) / maxLatency) * 100) : 100}%`,
          }}
        />
      ))}
    </div>
  )
}

export function FleetHealth() {
  const q = useQuery({
    queryKey: ["health-summary"],
    queryFn: async (): Promise<HealthSummary> => {
      const res = await fetch("/api/health/summary")
      if (!res.ok) throw new Error("failed to load health summary")
      return res.json()
    },
    refetchInterval: 30_000,
  })

  const refresh = () => q.refetch()

  const data = q.data
  const alerts: { severity: "error" | "warn"; text: string }[] = []
  for (const n of data?.nodes ?? []) {
    if (n.status === "down") {
      alerts.push({ severity: "error", text: `Node "${n.name}" is down` })
    }
    if (n.serversDown > 0) {
      alerts.push({
        severity: "warn",
        text: `${n.serversDown}/${n.serversTotal} servers not UP on "${n.name}"`,
      })
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Fleet health</h2>
        <div className="flex items-center gap-2">
          {data?.totals.serversDown ? (
            <Badge variant="warning">{data.totals.serversDown} servers down</Badge>
          ) : null}
          <Button size="xs" variant="outline" onClick={refresh} disabled={q.isFetching}>
            <RefreshCw className={"h-3 w-3 " + (q.isFetching ? "animate-spin" : "")} />
            Refresh
          </Button>
        </div>
      </div>

      {q.isLoading && <p className="text-muted-foreground">Checking nodes…</p>}

      {data && data.nodes.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No nodes registered yet — health monitoring starts once you register a
          node.
        </p>
      )}

      {alerts.length > 0 && (
        <div className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          {alerts.map((a) => (
            <div key={a.text} className="flex items-center gap-2 text-sm">
              <AlertTriangle
                className={
                  a.severity === "error"
                    ? "h-4 w-4 text-destructive"
                    : "h-4 w-4 text-yellow-500"
                }
              />
              {a.text}
            </div>
          ))}
        </div>
      )}

      {data && data.nodes.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Node</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Latency</th>
                <th className="px-3 py-2">Trend (last checks)</th>
                <th className="px-3 py-2">Servers</th>
              </tr>
            </thead>
            <tbody>
              {data.nodes.map((n) => (
                <tr key={n.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <span className="font-medium">{n.name}</span>
                    {n.version && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        HAProxy {n.version}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      variant={
                        n.status === "up"
                          ? "success"
                          : n.status === "down"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {n.status}
                    </Badge>
                    {n.error && (
                      <div className="mt-1 text-xs text-destructive">{n.error}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {n.latencyMs != null ? `${n.latencyMs} ms` : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <LatencyBars history={n.history} />
                  </td>
                  <td className="px-3 py-2">
                    {n.serversTotal === 0 ? (
                      "—"
                    ) : n.serversDown === 0 ? (
                      <span className="text-success">
                        {n.serversTotal}/{n.serversTotal} UP
                      </span>
                    ) : (
                      <span className="text-destructive">
                        {n.serversTotal - n.serversDown}/{n.serversTotal} UP
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
