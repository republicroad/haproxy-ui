import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  DataGrid,
  DataGridContainer,
  dataGridFeatures,
} from "#/components/reui/data-grid/data-grid"
import { DataGridTable } from "#/components/reui/data-grid/data-grid-table"
import { DataGridPagination } from "#/components/reui/data-grid/data-grid-pagination"
import { Button } from "#/components/ui/button"
import { useTable, filterFn_includesString, type ColumnDef, type TableFeatures } from "@tanstack/react-table"
import { dpDelete, withTransaction } from "#/lib/dataplane/client"
import type { Backend } from "#/lib/types"
import { BackendDialog, ServersModal } from "#/components/NodeConfigDialogs"
import { GridSearchInput } from "#/components/GridSearchInput"

export function BackendsTab({
  nodeId,
  backends,
  loading,
  onError,
  onChanged,
}: {
  nodeId: string
  backends: Backend[]
  loading: boolean
  onError: (m: string | null) => void
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [manage, setManage] = useState<Backend | null>(null)
  const [editingBe, setEditingBe] = useState<Backend | null>(null)
  const [beSearch, setBeSearch] = useState("")
  const columns: ColumnDef<TableFeatures, Backend>[] = [
    { accessorKey: "name", header: "Name" },
    { accessorKey: "mode", header: "Mode" },
    {
      id: "balance",
      header: "Balance",
      cell: ({ row }) => row.original.balance?.algorithm ?? "—",
    },
    {
      id: "servers",
      header: "Servers",
      cell: ({ row }) => String(row.original.servers?.length ?? 0),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => setManage(row.original)}>
            Servers
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditingBe(row.original)
              setOpen(true)
            }}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => remove(row.original)}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ]
  const table = useTable({
    data: backends,
    columns,
    features: dataGridFeatures,
    state: { globalFilter: beSearch },
    onGlobalFilterChange: setBeSearch,
    globalFilterFn: filterFn_includesString,
  })

  const removeMut = useMutation({
    mutationFn: (be: Backend) =>
      withTransaction(
        nodeId,
        async (tx) => {
          await dpDelete(
            nodeId,
            `services/haproxy/configuration/backends/${encodeURIComponent(be.name)}`,
            tx,
          )
        },
        {
          kind: "delete",
          resource: "backend",
          target: be.name,
          payload: { name: be.name, mode: be.mode, balance: be.balance },
        },
      ),
    onSuccess: (_, be) => {
      toast.success(`Backend "${be.name}" deleted`)
      onChanged()
    },
    onError: (e) => {
      toast.error("Failed to delete backend", { description: (e as Error).message })
      onError((e as Error).message)
    },
  })
  const remove = (be: Backend) => removeMut.mutate(be)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <GridSearchInput
          value={beSearch}
          onChange={setBeSearch}
          placeholder="Filter backends…"
        />
        <Button onClick={() => setOpen(true)}>New backend</Button>
      </div>
      {loading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <DataGrid table={table} recordCount={backends.length}>
          <DataGridContainer>
            <DataGridTable />
          </DataGridContainer>
          <DataGridPagination />
        </DataGrid>
      )}
      <BackendDialog
        open={open}
        nodeId={nodeId}
        edit={editingBe}
        onClose={() => {
          setOpen(false)
          setEditingBe(null)
        }}
        onCreated={() => {
          onChanged()
          setOpen(false)
          setEditingBe(null)
        }}
        onError={onError}
      />
      {manage && (
        <ServersModal
          nodeId={nodeId}
          backend={manage}
          onClose={() => setManage(null)}
          onChanged={onChanged}
          onError={onError}
        />
      )}
    </div>
  )
}
