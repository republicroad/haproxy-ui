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
import type { Frontend } from "#/lib/types"
import { FrontendDialog } from "#/components/NodeConfigDialogs"
import { GridSearchInput } from "#/components/GridSearchInput"

export function FrontendsTab({
  nodeId,
  frontends,
  loading,
  onError,
  onChanged,
}: {
  nodeId: string
  frontends: Frontend[]
  loading: boolean
  onError: (m: string | null) => void
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [editingFe, setEditingFe] = useState<Frontend | null>(null)
  const [feSearch, setFeSearch] = useState("")
  const columns: ColumnDef<TableFeatures, Frontend>[] = [
    { accessorKey: "name", header: "Name" },
    { accessorKey: "mode", header: "Mode" },
    {
      id: "bind",
      header: "Bind",
      cell: ({ row }) =>
        (Array.isArray(row.original.bind) ? row.original.bind : [])
          .map((b) => `${b.address}:${b.port}`)
          .join(", ") || "—",
    },
    { accessorKey: "default_backend", header: "Default backend" },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditingFe(row.original)
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
    data: frontends,
    columns,
    features: dataGridFeatures,
    state: { globalFilter: feSearch },
    onGlobalFilterChange: setFeSearch,
    globalFilterFn: filterFn_includesString,
  })

  const removeMut = useMutation({
    mutationFn: (fe: Frontend) =>
      withTransaction(
        nodeId,
        async (tx) => {
          await dpDelete(
            nodeId,
            `services/haproxy/configuration/frontends/${encodeURIComponent(fe.name)}`,
            tx,
          )
        },
        { kind: "delete", resource: "frontend", target: fe.name, payload: fe },
      ),
    onSuccess: (_, fe) => {
      toast.success(`Frontend "${fe.name}" deleted`)
      onChanged()
    },
    onError: (e) => {
      toast.error("Failed to delete frontend", { description: (e as Error).message })
      onError((e as Error).message)
    },
  })
  const remove = (fe: Frontend) => removeMut.mutate(fe)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <GridSearchInput
          value={feSearch}
          onChange={setFeSearch}
          placeholder="Filter frontends…"
        />
        <Button onClick={() => setOpen(true)}>New frontend</Button>
      </div>
      {loading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <DataGrid table={table} recordCount={frontends.length}>
          <DataGridContainer>
            <DataGridTable />
          </DataGridContainer>
          <DataGridPagination />
        </DataGrid>
      )}
      <FrontendDialog
        open={open}
        nodeId={nodeId}
        onClose={() => {
          setOpen(false)
          setEditingFe(null)
        }}
        edit={editingFe}
        onCreated={() => {
          onChanged()
          setOpen(false)
          setEditingFe(null)
        }}
        onError={onError}
      />
    </div>
  )
}
