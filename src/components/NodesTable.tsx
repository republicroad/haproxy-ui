"use client"

import { useState } from "react"
import {
  filterFn_includesString,
  useTable,
  type ColumnDef,
  type TableFeatures,
} from "@tanstack/react-table"
import {
  DataGrid,
  DataGridContainer,
  dataGridFeatures,
} from "#/components/reui/data-grid/data-grid"
import { DataGridTable } from "#/components/reui/data-grid/data-grid-table"
import { DataGridPagination } from "#/components/reui/data-grid/data-grid-pagination"
import { Badge } from "#/components/reui/badge"
import { Button } from "#/components/ui/button"
import { Link } from "@tanstack/react-router"
import type { NodeRow } from "#/lib/types"
import { GridSearchInput } from "./GridSearchInput"

function StatusBadge({ status }: { status: string }) {
  const v =
    status === "up"
      ? "success"
      : status === "down"
        ? "destructive"
        : "secondary"
  return <Badge variant={v}>{status}</Badge>
}

export function NodesTable({
  nodes,
  onTest,
  onEdit,
  onDelete,
  busyIds,
}: {
  nodes: NodeRow[]
  onTest?: (n: NodeRow) => void
  onEdit?: (n: NodeRow) => void
  onDelete?: (n: NodeRow) => void
  busyIds?: Set<string>
}) {
  const [search, setSearch] = useState("")
  const columns: ColumnDef<TableFeatures, NodeRow>[] = [
    {
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => (
        <Link
          to="/nodes/$id"
          params={{ id: row.original.id }}
          className="font-medium text-primary hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    { accessorKey: "apiUrl", header: "API URL" },
    {
      accessorKey: "group",
      header: "Group",
      cell: ({ row }) =>
        row.original.group ? (
          <Badge variant="secondary">{row.original.group}</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    { accessorKey: "haproxyVersion", header: "Version" },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => {
        const n = row.original
        const busy = busyIds?.has(n.id) ?? false
        return (
          <div className="flex justify-end gap-1">
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => onTest?.(n)}
            >
              Test
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => onEdit?.(n)}
            >
              Edit
            </Button>
            <Button
              size="xs"
              variant="destructive"
              disabled={busy}
              onClick={() => onDelete?.(n)}
            >
              Delete
            </Button>
          </div>
        )
      },
    },
  ]

  const table = useTable({
    data: nodes,
    columns,
    features: dataGridFeatures,
    state: { globalFilter: search },
    onGlobalFilterChange: setSearch,
    globalFilterFn: filterFn_includesString,
  })

  return (
    <DataGrid table={table} recordCount={nodes.length}>
      <div className="flex items-center justify-between gap-2">
        <GridSearchInput
          value={search}
          onChange={setSearch}
          placeholder="Filter by name or URL…"
        />
      </div>
      <DataGridContainer>
        <DataGridTable />
      </DataGridContainer>
      <DataGridPagination />
    </DataGrid>
  )
}
