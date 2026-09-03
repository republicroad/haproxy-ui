import { createFileRoute } from "@tanstack/react-router"
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query"
import { useEffect, useState } from "react"
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
import {
  Stepper,
  StepperNav,
  StepperItem,
  StepperTrigger,
  StepperIndicator,
  StepperTitle,
  StepperSeparator,
} from "#/components/reui/stepper"
import { useTable, type ColumnDef, type TableFeatures } from "@tanstack/react-table"
import {
  dpGet,
  dpRaw,
  withTransaction,
  dpDelete,
} from "#/lib/dataplane/client"
import type { NodeRow, Frontend, Backend } from "#/lib/types"
import {
  FrontendDialog,
  BackendDialog,
  ServersModal,
} from "#/components/NodeConfigDialogs"

const TABS = ["overview", "frontends", "backends", "stats", "raw"] as const
type Tab = (typeof TABS)[number]

async function fetchNode(id: string): Promise<NodeRow> {
  const res = await fetch(`/api/nodes/${id}`)
  if (!res.ok) throw new Error("node not found")
  return res.json()
}

function NodeDetail() {
  const { id } = Route.useParams()
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>("overview")
  const [mounted, setMounted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setMounted(true), [])

  const nodeQ = useQuery({ queryKey: ["node", id], queryFn: () => fetchNode(id) })
  const infoQ = useQuery({
    queryKey: ["info", id],
    queryFn: () => dpGet<Record<string, unknown>>(id, "services/haproxy/runtime/info"),
    enabled: mounted && tab === "overview",
    refetchInterval: 15_000,
  })
  const feQ = useQuery({
    queryKey: ["frontends", id],
    queryFn: () => dpGet<Frontend[]>(id, "services/haproxy/configuration/frontends"),
    enabled: mounted && tab === "frontends",
  })
  const beQ = useQuery({
    queryKey: ["backends", id],
    queryFn: () => dpGet<Backend[]>(id, "services/haproxy/configuration/backends"),
    enabled: mounted && (tab === "backends" || tab === "stats"),
  })
  const rawQ = useQuery({
    queryKey: ["raw", id],
    queryFn: () => dpRaw(id, "services/haproxy/configuration/raw"),
    enabled: mounted && tab === "raw",
  })

  const refetch = () => {
    qc.invalidateQueries({ queryKey: ["frontends", id] })
    qc.invalidateQueries({ queryKey: ["backends", id] })
    qc.invalidateQueries({ queryKey: ["info", id] })
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{nodeQ.data?.name ?? id}</h1>
          <p className="text-muted-foreground">{nodeQ.data?.apiUrl}</p>
        </div>
        <Badge variant={nodeQ.data?.status === "up" ? "success" : "secondary"}>
          {nodeQ.data?.status ?? "…"}
        </Badge>
      </div>

      <Stepper
        value={TABS.indexOf(tab) + 1}
        onValueChange={(s) => setTab(TABS[s - 1] as Tab)}
        className="border-b border-border pb-3"
      >
        <StepperNav>
          {TABS.map((t, i) => (
            <StepperItem key={t} step={i + 1}>
              <StepperTrigger>
                <StepperIndicator>{i + 1}</StepperIndicator>
                <StepperTitle className="capitalize">{t}</StepperTitle>
              </StepperTrigger>
              {i < TABS.length - 1 && <StepperSeparator />}
            </StepperItem>
          ))}
        </StepperNav>
      </Stepper>

      {error && <Alert variant="default">{error}</Alert>}

      {tab === "overview" && (
        <OverviewTab info={infoQ.data} loading={infoQ.isLoading} error={infoQ.error} />
      )}

      {tab === "frontends" && (
        <FrontendsTab
          nodeId={id}
          frontends={feQ.data ?? []}
          loading={feQ.isLoading}
          onError={setError}
          onChanged={refetch}
        />
      )}

      {tab === "backends" && (
        <BackendsTab
          nodeId={id}
          backends={beQ.data ?? []}
          loading={beQ.isLoading}
          onError={setError}
          onChanged={refetch}
        />
      )}

      {tab === "stats" && (
        <StatsTab nodeId={id} backends={beQ.data ?? []} loading={beQ.isLoading} />
      )}

      {tab === "raw" && (
        <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-card p-4 text-xs">
          {rawQ.isLoading ? "Loading…" : rawQ.data ?? "// no config"}
        </pre>
      )}
    </div>
  )
}

function OverviewTab({
  info,
  loading,
  error,
}: {
  info?: Record<string, unknown>
  loading: boolean
  error: Error | null
}) {
  if (loading) return <p className="text-muted-foreground">Loading runtime info…</p>
  if (error) return <Alert variant="default">Cannot read node: {error.message}</Alert>
  // dataplaneapi nests the useful fields under "info"; fall back to the top level.
  const src =
    (info?.info as Record<string, unknown> | undefined) ?? info ?? {}
  const entries = Object.entries(src)
    .filter(([, v]) => typeof v !== "object")
    .slice(0, 9)
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
      {entries.map(([k, v]) => (
        <div key={k} className="rounded-lg border border-border bg-card p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {k}
          </div>
          <div className="truncate text-sm font-medium">{String(v)}</div>
        </div>
      ))}
    </div>
  )
}

function FrontendsTab({
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
  const columns: ColumnDef<TableFeatures, Frontend>[] = [
    { accessorKey: "name", header: "Name" },
    { accessorKey: "mode", header: "Mode" },
    {
      id: "bind",
      header: "Bind",
      cell: ({ row }) =>
        (row.original.bind ?? [])
          .map((b) => `${b.address}:${b.port}`)
          .join(", ") || "—",
    },
    { accessorKey: "default_backend", header: "Default backend" },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="destructive"
            onClick={() => remove(row.original.name)}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ]
  const table = useTable({ data: frontends, columns, features: dataGridFeatures })

  const removeMut = useMutation({
    mutationFn: (name: string) =>
      withTransaction(nodeId, async (tx) => {
        await dpDelete(
          nodeId,
          `services/haproxy/configuration/frontends/${encodeURIComponent(name)}`,
          tx,
        )
      }),
    onSuccess: (_, name) => {
      toast.success(`Frontend "${name}" deleted`)
      onChanged()
    },
    onError: (e) => {
      toast.error("Failed to delete frontend", { description: (e as Error).message })
      onError((e as Error).message)
    },
  })
  const remove = (name: string) => removeMut.mutate(name)

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
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
        onClose={() => setOpen(false)}
        onCreated={() => {
          onChanged()
          setOpen(false)
        }}
        onError={onError}
      />
    </div>
  )
}

function BackendsTab({
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
            variant="destructive"
            onClick={() => remove(row.original.name)}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ]
  const table = useTable({ data: backends, columns, features: dataGridFeatures })

  const removeMut = useMutation({
    mutationFn: (name: string) =>
      withTransaction(nodeId, async (tx) => {
        await dpDelete(
          nodeId,
          `services/haproxy/configuration/backends/${encodeURIComponent(name)}`,
          tx,
        )
      }),
    onSuccess: (_, name) => {
      toast.success(`Backend "${name}" deleted`)
      onChanged()
    },
    onError: (e) => {
      toast.error("Failed to delete backend", { description: (e as Error).message })
      onError((e as Error).message)
    },
  })
  const remove = (name: string) => removeMut.mutate(name)

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
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
        onClose={() => setOpen(false)}
        onCreated={() => {
          onChanged()
          setOpen(false)
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

function StatsTab({
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
    refetchInterval: 10_000,
  })

  const rows = statsQ.data ?? []
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
      cell: ({ row }) => row.original.admin_state ?? "—",
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

export const Route = createFileRoute("/nodes/$id")({ component: NodeDetail })
