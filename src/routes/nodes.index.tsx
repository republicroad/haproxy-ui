import { createFileRoute } from "@tanstack/react-router"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"
import { NodesTable } from "#/components/NodesTable"
import { NodeFormDialog } from "#/components/NodeFormDialog"
import { ConfirmDialog } from "#/components/ConfirmDialog"
import { NodesImportExportButtons } from "#/components/ImportExportButtons"
import { CompareModal } from "#/components/CompareModal"
import { Button } from "#/components/ui/button"
import type { NodeRow } from "#/lib/types"
import { POLL } from "#/lib/poll"

export const NODES_QUERY_KEY = ["nodes"] as const

async function fetchNodes(): Promise<NodeRow[]> {
  const res = await fetch("/api/nodes")
  if (!res.ok) throw new Error("failed to load nodes")
  return res.json()
}

export async function testNode(id: string): Promise<{
  ok: boolean
  version?: string | null
  error?: string
}> {
  const res = await fetch(`/api/nodes/${id}/test`, { method: "POST" })
  if (!res.ok) throw new Error("test request failed")
  return res.json()
}

function NodesPage() {
  const qc = useQueryClient()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<NodeRow | null>(null)
  const [deleting, setDeleting] = useState<NodeRow | null>(null)
  const [compareOpen, setCompareOpen] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: NODES_QUERY_KEY,
    queryFn: fetchNodes,
    refetchInterval: POLL.NODES,
  })
  const nodes = data ?? []

  const refresh = () => qc.invalidateQueries({ queryKey: NODES_QUERY_KEY })

  const testMut = useMutation({
    mutationFn: testNode,
    onSuccess: (r, id) => {
      const n = nodes.find((x) => x.id === id)
      if (r.ok) {
        toast.success(`Connected to ${n?.name ?? "node"}`, {
          description: r.version ? `HAProxy ${r.version}` : undefined,
        })
      } else {
        toast.error(`Cannot reach ${n?.name ?? "node"}`, {
          description: r.error,
        })
      }
      refresh()
    },
    onError: (e) => toast.error("Connection test failed", { description: (e as Error).message }),
  })

  const testAllMut = useMutation({
    mutationFn: async () => {
      const results = await Promise.allSettled(nodes.map((n) => testNode(n.id)))
      return nodes.map((n, i) => ({
        node: n,
        result: results[i],
      }))
    },
    onSuccess: (rows) => {
      const up = rows.filter(
        (r) => r.result.status === "fulfilled" && r.result.value.ok,
      ).length
      const down = rows.length - up
      toast.success(`Tested ${rows.length} nodes: ${up} up, ${down} down`)
      refresh()
    },
    onError: (e) => toast.error("Batch test failed", { description: (e as Error).message }),
  })

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/nodes/${id}`, { method: "DELETE" })
      if (!res.ok && res.status !== 204) throw new Error("failed to delete node")
    },
    onSuccess: (_, id) => {
      toast.success(`Deleted node ${nodes.find((n) => n.id === id)?.name ?? id}`)
      setDeleting(null)
      refresh()
    },
    onError: (e) => toast.error("Delete failed", { description: (e as Error).message }),
  })

  const busyIds = new Set<string>()
  if (testMut.isPending && testMut.variables) busyIds.add(testMut.variables)
  if (deleteMut.isPending && deleteMut.variables) busyIds.add(deleteMut.variables)

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Nodes</h1>
          <p className="text-muted-foreground">
            Registered HAProxy instances managed via Data Plane API
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <NodesImportExportButtons onChanged={refresh} />
          <Button
            variant="outline"
            onClick={() => setCompareOpen(true)}
            disabled={nodes.length < 2}
          >
            Compare
          </Button>
          <Button
            variant="outline"
            onClick={() => testAllMut.mutate()}
            disabled={testAllMut.isPending || nodes.length === 0}
          >
            {testAllMut.isPending ? "Testing…" : "Test all"}
          </Button>
          <Button
            onClick={() => {
              setEditing(null)
              setFormOpen(true)
            }}
          >
            Register node
          </Button>
        </div>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <NodesTable
          nodes={nodes}
          busyIds={busyIds}
          onTest={(n) => testMut.mutate(n.id)}
          onEdit={(n) => {
            setEditing(n)
            setFormOpen(true)
          }}
          onDelete={(n) => setDeleting(n)}
        />
      )}

      <NodeFormDialog
        open={formOpen}
        node={editing}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          toast.success(editing ? "Node updated" : "Node registered")
          refresh()
        }}
      />

      {compareOpen && (
        <CompareModal nodes={nodes} onClose={() => setCompareOpen(false)} />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete node"
        message={`This permanently removes "${deleting?.name}" from the registry. The HAProxy instance itself is not affected.`}
        pending={deleteMut.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && deleteMut.mutate(deleting.id)}
      />
    </div>
  )
}

export const Route = createFileRoute("/nodes/")({ component: NodesPage })
