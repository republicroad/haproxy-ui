"use client"

import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Button } from "#/components/ui/button"
import { dpGet } from "#/lib/dataplane/client"

type StickTable = {
  name: string
  size?: number
  used?: number
  type?: string
  fields?: { field: string; type?: string; period?: number }[]
}

type StickTableEntry = Record<string, unknown> & {
  id?: string
  key?: string
  use?: boolean
  exp?: number
}

const INTERESTING = [
  "exp",
  "conn_cur",
  "conn_cnt",
  "conn_rate",
  "http_req_cnt",
  "http_req_rate",
  "sess_cnt",
  "sess_rate",
  "bytes_in_cnt",
  "bytes_out_cnt",
  "server_id",
]

export function StickTablesTab({ nodeId }: { nodeId: string }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const [selected, setSelected] = useState("")
  const [pageSize] = useState(100)
  const [offset, setOffset] = useState(0)

  const tablesQ = useQuery({
    queryKey: ["stick-tables", nodeId],
    queryFn: () => dpGet<StickTable[]>(nodeId, "services/haproxy/runtime/stick_tables"),
    enabled: mounted,
    refetchInterval: 15_000,
  })
  const tables = tablesQ.data ?? []
  const effectiveName = selected || tables[0]?.name || ""

  const entriesQ = useQuery({
    queryKey: ["stick-entries", nodeId, effectiveName, offset, pageSize],
    queryFn: () =>
      dpGet<StickTableEntry[]>(
        nodeId,
        `services/haproxy/runtime/stick_tables/${encodeURIComponent(effectiveName)}/entries?count=${pageSize}&offset=${offset}`,
      ),
    enabled: mounted && Boolean(effectiveName),
    refetchInterval: 15_000,
  })
  const entries = entriesQ.data ?? []
  const table = tables.find((t) => t.name === effectiveName)
  const extraKeys = [
    ...new Set(
      entries
        .flatMap((e) => Object.keys(e))
        .filter((k) => k !== "id" && k !== "key" && !INTERESTING.includes(k)),
    ),
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <select
            className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
            value={effectiveName}
            onChange={(e) => {
              setSelected(e.target.value)
              setOffset(0)
            }}
            aria-label="stick table"
          >
            {tables.length === 0 && <option value="">no stick tables</option>}
            {tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name} ({t.used ?? "?"}/{t.size ?? "?"} used)
              </option>
            ))}
          </select>
          {table && (
            <span className="text-xs text-muted-foreground">
              type: {table.type ?? "?"} · fields:{" "}
              {(table.fields ?? []).map((f) => f.field).join(", ") || "—"}
            </span>
          )}
        </div>
        <Button size="xs" variant="outline" onClick={() => entriesQ.refetch()} disabled={entriesQ.isFetching}>
          Refresh
        </Button>
      </div>

      {!effectiveName ? (
        <p className="text-sm text-muted-foreground">
          No stick tables on this node (they appear when a backend uses
          stick-table).
        </p>
      ) : entriesQ.isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <div className="overflow-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Key</th>
                {INTERESTING.filter((f) => entries.some((e) => f in e)).map((f) => (
                  <th key={f} className="px-3 py-2">
                    {f}
                  </th>
                ))}
                {extraKeys.map((f) => (
                  <th key={f} className="px-3 py-2">
                    {f}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-3 text-muted-foreground">
                    No entries at offset {offset}.
                  </td>
                </tr>
              )}
              {entries.map((e, i) => (
                <tr key={e.id ?? `${e.key}-${i}`} className="border-t border-border">
                  <td className="px-3 py-2 font-mono text-xs">{String(e.key ?? "—")}</td>
                  {INTERESTING.filter((f) => entries.some((x) => f in x)).map((f) => (
                    <td key={f} className="px-3 py-2">
                      {e[f] === undefined ? "—" : String(e[f])}
                    </td>
                  ))}
                  {extraKeys.map((f) => (
                    <td key={f} className="px-3 py-2">
                      {e[f] === undefined ? "—" : String(e[f])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Showing entries {entries.length > 0 ? offset + 1 : 0}–
          {offset + entries.length}
        </span>
        <div className="flex gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={offset === 0 || entriesQ.isFetching}
            onClick={() => setOffset(Math.max(0, offset - pageSize))}
          >
            Prev
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={entries.length < pageSize || entriesQ.isFetching}
            onClick={() => setOffset(offset + pageSize)}
          >
            Next
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Read-only view of HAProxy runtime stick tables; auto-refreshes every 15s.
      </p>
    </div>
  )
}
