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
import { Modal } from "#/components/Modal"
import { ConfirmDialog } from "#/components/ConfirmDialog"
import { SyncModal } from "#/components/SyncModal"
import { diffLines } from "#/lib/diff"

const TABS = ["overview", "frontends", "backends", "stats", "history", "raw"] as const
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
  const [syncOpen, setSyncOpen] = useState(false)
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
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSyncOpen(true)}
            disabled={!nodeQ.data}
          >
            Sync to nodes
          </Button>
          <Badge variant={nodeQ.data?.status === "up" ? "success" : "secondary"}>
            {nodeQ.data?.status ?? "…"}
          </Badge>
        </div>
      </div>

      {syncOpen && <SyncModal nodeId={id} onClose={() => setSyncOpen(false)} />}

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

      {tab === "history" && <HistoryTab nodeId={id} />}

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
            onClick={() => remove(row.original)}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ]
  const table = useTable({ data: frontends, columns, features: dataGridFeatures })

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
            onClick={() => remove(row.original)}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ]
  const table = useTable({ data: backends, columns, features: dataGridFeatures })

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

type ChangeListItem = {
  id: string
  ts: number
  kind: string
  resource: string
  target: string
  parent: string | null
  txId: string | null
  reverted: number
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

function HistoryTab({ nodeId }: { nodeId: string }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const qc = useQueryClient()
  const [diffFor, setDiffFor] = useState<ChangeListItem | null>(null)
  const [revertFor, setRevertFor] = useState<ChangeListItem | null>(null)
  const [cleanupFor, setCleanupFor] = useState<"days" | "limit" | null>(null)

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
      id: "actions",
      header: "",
      cell: ({ row }) => {
        const c = row.original
        const revertable = !c.reverted && (c.kind === "create" || c.kind === "delete")
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
  const table = useTable({ data: changes, columns, features: dataGridFeatures })

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
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {total} record{total === 1 ? "" : "s"}
            </span>
            <Button
              size="xs"
              variant="outline"
              onClick={() => setCleanupFor("days")}
              disabled={cleanupMut.isPending}
            >
              Clean up old records
            </Button>
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

export const Route = createFileRoute("/nodes/$id")({ component: NodeDetail })
