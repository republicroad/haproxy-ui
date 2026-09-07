import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  DataGrid,
  DataGridContainer,
  dataGridFeatures,
} from "#/components/reui/data-grid/data-grid"
import { DataGridTable } from "#/components/reui/data-grid/data-grid-table"
import { DataGridPagination } from "#/components/reui/data-grid/data-grid-pagination"
import { Badge } from "#/components/reui/badge"
import { Button } from "#/components/ui/button"
import { Alert } from "#/components/reui/alert"
import { useTable, type ColumnDef, type TableFeatures } from "@tanstack/react-table"
import { dpGet, dpPut } from "#/lib/dataplane/client"
import type { Backend } from "#/lib/types"
import { POLL } from "#/lib/poll"

type RuntimeServer = {
  name: string
  address?: string
  port?: number
  weight?: number
  operational_state?: string
  admin_state?: string
  fqdn?: string
  backend_name?: string
}

type RuntimeServerRow = RuntimeServer & { backend: string }

function RuntimeStateBadge({ state }: { state?: string }) {
  const v =
    state === "ready"
      ? "success"
      : state === "down"
        ? "destructive"
        : "secondary"
  return <Badge variant={v}>{state ?? "unknown"}</Badge>
}

export function StatsTab({
  nodeId,
  backends,
  loading,
}: {
  nodeId: string
  backends: Backend[]
  loading: boolean
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const statsQ = useQuery({
    queryKey: ["runtime-servers", nodeId, backends.map((b) => b.name).join(",")],
    queryFn: async () => {
      const results = await Promise.allSettled(
        backends.map(async (b) => ({
          backend: b.name,
          servers: await dpGet<RuntimeServer[]>(
            nodeId,
            `services/haproxy/runtime/backends/${encodeURIComponent(b.name)}/servers`,
          ),
        })),
      )
      const rows: RuntimeServerRow[] = []
      for (const r of results) {
        if (r.status === "fulfilled") {
          for (const s of r.value.servers ?? []) {
            rows.push({ ...s, backend: r.value.backend })
          }
        } else {
          rows.push({
            name: "?",
            backend: "",
            operational_state: "unreachable",
          })
        }
      }
      return rows
    },
    enabled: mounted,
    refetchInterval: POLL.STATS,
  })

  const rows = statsQ.data ?? []
  const qc = useQueryClient()
  const stateMut = useMutation({
    mutationFn: async (v: {
      backend: string
      server: string
      admin_state: "ready" | "drain" | "maint"
    }) => {
      await dpPut(
        nodeId,
        `services/haproxy/runtime/backends/${encodeURIComponent(v.backend)}/servers/${encodeURIComponent(v.server)}`,
        { admin_state: v.admin_state },
      )
    },
    onSuccess: (_, v) => {
      toast.success(`${v.server} → ${v.admin_state}`)
      qc.invalidateQueries({ queryKey: ["runtime-servers", nodeId] })
    },
    onError: (e) =>
      toast.error("Failed to set server state", {
        description: (e as Error).message,
      }),
  })

  const columns: ColumnDef<TableFeatures, RuntimeServerRow>[] = [
    { accessorKey: "backend", header: "Backend" },
    {
      accessorKey: "name",
      header: "Server",
      cell: ({ row }) => row.original.name ?? "—",
    },
    {
      id: "address",
      header: "Address",
      cell: ({ row }) =>
        row.original.address
          ? `${row.original.address}:${row.original.port ?? "?"}`
          : "—",
    },
    { accessorKey: "weight", header: "Weight" },
    {
      id: "state",
      header: "State",
      cell: ({ row }) => (
        <RuntimeStateBadge state={row.original.operational_state} />
      ),
    },
    {
      id: "admin",
      header: "Admin",
      cell: ({ row }) => {
        const s = row.original
        if (!s.backend || !s.name || s.name === "?")
          return s.admin_state ?? "—"
        const current = s.admin_state ?? "ready"
        const states = ["ready", "drain", "maint"] as const
        return (
          <div className="flex items-center gap-1">
            {states.map((st) => (
              <Button
                key={st}
                size="xs"
                variant={current === st ? "default" : "outline"}
                disabled={stateMut.isPending}
                onClick={() =>
                  stateMut.mutate({ backend: s.backend, server: s.name!, admin_state: st })
                }
              >
                {st}
              </Button>
            ))}
          </div>
        )
      },
    },
  ]
  const table = useTable({ data: rows, columns, features: dataGridFeatures })

  if (loading) return <p className="text-muted-foreground">Loading…</p>
  if (backends.length === 0)
    return (
      <p className="text-muted-foreground">
        No backends configured — create one in the Backends tab.
      </p>
    )
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Live server states from the HAProxy runtime API, refreshed every 10s
        </p>
        <Button variant="outline" size="sm" onClick={() => statsQ.refetch()}>
          Refresh
        </Button>
      </div>
      {statsQ.isError && (
        <Alert variant="default">
          Cannot read runtime states: {(statsQ.error as Error).message}
        </Alert>
      )}
      <DataGrid table={table} recordCount={rows.length}>
        <DataGridContainer>
          <DataGridTable />
        </DataGridContainer>
        <DataGridPagination />
      </DataGrid>
    </div>
  )
}
