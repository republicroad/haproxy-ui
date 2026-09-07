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
 */
export function LogsTab({
  nodeId,
  frontends,
}: {
  nodeId: string
  frontends: Frontend[]
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

  return (
    <div className="space-y-3">
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
                <tr key={i} className="border-t border-border">
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
    </div>
  )
}
