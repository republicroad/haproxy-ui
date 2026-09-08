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
import { useTable, filterFn_includesString, type ColumnDef, type TableFeatures } from "@tanstack/react-table"
import { Modal } from "#/components/Modal"
import { ConfirmDialog } from "#/components/ConfirmDialog"
import { GridSearchInput } from "#/components/GridSearchInput"
import { diffLines } from "#/lib/diff"

export type ChangeListItem = {
  id: string
  ts: number
  kind: string
  resource: string
  target: string
  parent: string | null
  txId: string | null
  reverted: number
  actor: string | null
}

async function fetchChanges(nodeId: string): Promise<{
  changes: ChangeListItem[]
  total: number
}> {
  const res = await fetch(`/api/nodes/${nodeId}/changes`)
  if (!res.ok) throw new Error("failed to load changes")
  return res.json()
}

function ChangeKindBadge({ kind }: { kind: string }) {
  const v =
    kind === "create" ? "success" : kind === "delete" ? "destructive" : "secondary"
  return <Badge variant={v}>{kind}</Badge>
}

function DiffModal({
  nodeId,
  change,
  changes,
  onClose,
}: {
  nodeId: string
  change: ChangeListItem
  /** DESC-ordered list; the entry after `change` is the previous snapshot. */
  changes: ChangeListItem[]
  onClose: () => void
}) {
  const prev = changes[changes.findIndex((c) => c.id === change.id) + 1]
  const q = useQuery({
    queryKey: ["change-diff", nodeId, change.id, prev?.id ?? "none"],
    queryFn: async () => {
      const curRes = await fetch(`/api/nodes/${nodeId}/changes/${change.id}`)
      if (!curRes.ok) throw new Error("failed to load change")
      const cur = (await curRes.json()) as { rawAfter: string | null }
      let oldRaw = ""
      if (prev) {
        const oldRes = await fetch(`/api/nodes/${nodeId}/changes/${prev.id}`)
        if (oldRes.ok) oldRaw = ((await oldRes.json()) as { rawAfter: string | null }).rawAfter ?? ""
      }
      return diffLines(oldRaw, cur.rawAfter ?? "")
    },
  })
  return (
    <Modal open onClose={onClose} title={`Config diff — ${change.kind} ${change.resource} "${change.target}"`}>
      {q.isLoading && <p className="text-sm text-muted-foreground">Computing diff…</p>}
      {q.isError && (
        <Alert variant="default">Cannot compute diff: {(q.error as Error).message}</Alert>
      )}
      {q.data && (
        <div className="max-h-[55vh] overflow-auto rounded-md border border-border bg-card text-xs">
          {q.data.removed.length === 0 && q.data.added.length === 0 && (
            <p className="p-3 text-muted-foreground">No differences recorded.</p>
          )}
          {q.data.removed.map((l, i) => (
            <div key={`rm-${i}`} className="whitespace-pre-wrap bg-destructive/10 px-3 py-0.5 text-destructive">
              - {l}
            </div>
          ))}
          {q.data.added.map((l, i) => (
            <div key={`ad-${i}`} className="whitespace-pre-wrap bg-success/10 px-3 py-0.5 text-success">
              + {l}
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  )
}

export function HistoryTab({ nodeId }: { nodeId: string }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const qc = useQueryClient()
  const [diffFor, setDiffFor] = useState<ChangeListItem | null>(null)
  const [revertFor, setRevertFor] = useState<ChangeListItem | null>(null)
  const [cleanupFor, setCleanupFor] = useState<"days" | "limit" | null>(null)
  const [histSearch, setHistSearch] = useState("")

  const q = useQuery({
    queryKey: ["changes", nodeId],
    queryFn: () => fetchChanges(nodeId),
    enabled: mounted,
  })
  const changes = q.data?.changes ?? []
  const total = q.data?.total ?? 0

  const revertMut = useMutation({
    mutationFn: async (cid: string) => {
      const res = await fetch(`/api/nodes/${nodeId}/changes/${cid}/revert`, {
        method: "POST",
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error ?? "revert failed")
      return j
    },
    onSuccess: () => {
      toast.success("Change reverted")
      setRevertFor(null)
      qc.invalidateQueries({ queryKey: ["changes", nodeId] })
    },
    onError: (e) =>
      toast.error("Revert failed", { description: (e as Error).message }),
  })

  const cleanupMut = useMutation({
    mutationFn: async (opts: { days?: number; limit?: number }) => {
      const params = new URLSearchParams()
      if (opts.days) params.set("days", String(opts.days))
      if (opts.limit) params.set("limit", String(opts.limit))
      const res = await fetch(`/api/nodes/${nodeId}/changes?${params}`, {
        method: "DELETE",
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error ?? "cleanup failed")
      return j as { deleted: number; total: number }
    },
    onSuccess: (r) => {
      toast.success(`Cleaned up ${r.deleted} record${r.deleted === 1 ? "" : "s"}`)
      setCleanupFor(null)
      qc.invalidateQueries({ queryKey: ["changes", nodeId] })
    },
    onError: (e) =>
      toast.error("Cleanup failed", { description: (e as Error).message }),
  })

  const columns: ColumnDef<TableFeatures, ChangeListItem>[] = [
    {
      accessorKey: "ts",
      header: "Time",
      cell: ({ row }) => new Date(row.original.ts).toLocaleString(),
    },
    {
      id: "kind",
      header: "Change",
      cell: ({ row }) => <ChangeKindBadge kind={row.original.kind} />,
    },
    { accessorKey: "resource", header: "Resource" },
    {
      id: "target",
      header: "Target",
      cell: ({ row }) => (
        <span>
          {row.original.target}
          {row.original.parent && (
            <span className="text-muted-foreground"> in {row.original.parent}</span>
          )}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) =>
        row.original.reverted ? <Badge variant="secondary">reverted</Badge> : null,
    },
    {
      accessorKey: "actor",
      header: "By",
      cell: ({ row }) => row.original.actor ?? "—",
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => {
        const c = row.original
        const revertable =
          !c.reverted &&
          (c.kind === "create" || c.kind === "delete") &&
          ["frontend", "backend", "server"].includes(c.resource)
        return (
          <div className="flex justify-end gap-1">
            <Button size="xs" variant="outline" onClick={() => setDiffFor(c)}>
              Diff
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={!revertable || revertMut.isPending}
              onClick={() => setRevertFor(c)}
            >
              Revert
            </Button>
          </div>
        )
      },
    },
  ]
  const table = useTable({
    data: changes,
    columns,
    features: dataGridFeatures,
    state: { globalFilter: histSearch },
    onGlobalFilterChange: setHistSearch,
    globalFilterFn: filterFn_includesString,
  })

  return (
    <div className="space-y-3">
      {q.isLoading && <p className="text-muted-foreground">Loading…</p>}
      {!q.isLoading && changes.length === 0 && (
        <p className="text-muted-foreground">
          No configuration changes recorded yet. Create or delete frontends,
          backends, or servers to build history.
        </p>
      )}
      {changes.length > 0 && (
        <>
          <div className="flex items-center justify-between gap-2">
            <GridSearchInput
              value={histSearch}
              onChange={setHistSearch}
              placeholder="Filter history…"
            />
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                {total} record{total === 1 ? "" : "s"}
              </span>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  window.location.href = `/api/nodes/${nodeId}/changes/export`
                }}
              >
                Export CSV
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => setCleanupFor("days")}
                disabled={cleanupMut.isPending}
              >
                Clean up old records
              </Button>
            </div>
          </div>
          <DataGrid table={table} recordCount={changes.length}>
            <DataGridContainer>
              <DataGridTable />
            </DataGridContainer>
            <DataGridPagination />
          </DataGrid>
        </>
      )}

      {diffFor && (
        <DiffModal
          nodeId={nodeId}
          change={diffFor}
          changes={changes}
          onClose={() => setDiffFor(null)}
        />
      )}
      <ConfirmDialog
        open={Boolean(revertFor)}
        title="Revert change"
        message={
          revertFor
            ? `This will ${revertFor.kind === "create" ? "delete" : "re-create"} ${revertFor.resource} "${revertFor.target}"${revertFor.parent ? ` in ${revertFor.parent}` : ""} inside a validated transaction. Continue?`
            : ""
        }
        confirmLabel="Revert"
        pending={revertMut.isPending}
        onCancel={() => setRevertFor(null)}
        onConfirm={() => revertFor && revertMut.mutate(revertFor.id)}
      />
      <ConfirmDialog
        open={cleanupFor === "days"}
        title="Clean up old records"
        message="Delete all change records older than 30 days? This cannot be undone."
        confirmLabel="Delete old records"
        pending={cleanupMut.isPending}
        onCancel={() => setCleanupFor(null)}
        onConfirm={() => cleanupMut.mutate({ days: 30 })}
      />
    </div>
  )
}
