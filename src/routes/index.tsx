import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { NodesTable } from "#/components/NodesTable"
import { FleetHealth } from "#/components/FleetHealth"
import type { NodeRow } from "#/lib/types"
import { POLL } from "#/lib/poll"

async function fetchNodes(): Promise<NodeRow[]> {
  const res = await fetch("/api/nodes")
  if (!res.ok) throw new Error("failed to load nodes")
  return res.json()
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: "success" | "destructive"
}) {
  const color =
    tone === "success"
      ? "text-success"
      : tone === "destructive"
        ? "text-destructive"
        : ""
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={"text-3xl font-bold " + color}>{value}</div>
    </div>
  )
}

function Overview() {
  const { data, isLoading } = useQuery({
    queryKey: ["nodes"],
    queryFn: fetchNodes,
    refetchInterval: POLL.NODES,
  })
  const nodes = data ?? []
  const up = nodes.filter((n) => n.status === "up").length
  const down = nodes.filter((n) => n.status === "down").length

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Overview</h1>
        <p className="text-muted-foreground">HAProxy fleet at a glance</p>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Nodes" value={nodes.length} />
        <Stat label="Up" value={up} tone="success" />
        <Stat label="Down" value={down} tone="destructive" />
        <Stat label="Unknown" value={nodes.length - up - down} />
      </div>
      <FleetHealth />
      <div>
        <h2 className="mb-2 text-lg font-semibold">Nodes</h2>
        {isLoading ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : (
          <NodesTable nodes={nodes} />
        )}
      </div>
    </div>
  )
}

export const Route = createFileRoute("/")({ component: Overview })
