import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
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
import { dpGet, dpRaw } from "#/lib/dataplane/client"
import type { NodeRow, Frontend, Backend } from "#/lib/types"
import { NodeConfigImportExportButtons } from "#/components/ImportExportButtons"
import { SyncModal } from "#/components/SyncModal"
import { UpgradeModal } from "#/components/UpgradeModal"
import { AclsTab, MapsTab } from "#/components/AclMapsTabs"
import { RulesTab } from "#/components/tabs/RulesTab"
import { WafBotsTab } from "#/components/tabs/WafBotsTab"
import { LogsTab } from "#/components/tabs/LogsTab"
import { TrafficTab } from "#/components/TrafficTab"
import { StickTablesTab } from "#/components/StickTablesTab"
import { CertificatesTab } from "#/components/CertificatesTab"
import { UserlistsTab } from "#/components/UserlistsTab"
import { TopologyView } from "#/components/TopologyView"
import { OverviewTab } from "#/components/tabs/OverviewTab"
import { FrontendsTab } from "#/components/tabs/FrontendsTab"
import { BackendsTab } from "#/components/tabs/BackendsTab"
import { StatsTab } from "#/components/tabs/StatsTab"
import { HistoryTab } from "#/components/tabs/HistoryTab"
import { normalizeFrontends, normalizeBackends } from "#/lib/normalize"
import { POLL } from "#/lib/poll"

const TABS = ["overview", "frontends", "backends", "traffic", "acls", "rules", "waf", "logs", "maps", "certs", "userlists", "stats", "stick", "history", "raw"] as const
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
  const [upgradeOpen, setUpgradeOpen] = useState(false)
  useEffect(() => setMounted(true), [])

  const nodeQ = useQuery({ queryKey: ["node", id], queryFn: () => fetchNode(id) })
  const infoQ = useQuery({
    queryKey: ["info", id],
    queryFn: () => dpGet<Record<string, unknown>>(id, "services/haproxy/runtime/info"),
    enabled: mounted && tab === "overview",
    refetchInterval: POLL.NODES,
  })
  const feQ = useQuery({
    queryKey: ["frontends", id],
    queryFn: async () =>
      normalizeFrontends(
        await dpGet<Frontend[]>(id, "services/haproxy/configuration/frontends"),
      ),
    enabled: mounted && ["frontends", "acls", "rules", "waf", "logs"].includes(tab),
  })
  const beQ = useQuery({
    queryKey: ["backends", id],
    queryFn: async () =>
      normalizeBackends(
        await dpGet<Backend[]>(id, "services/haproxy/configuration/backends"),
      ),
    enabled: mounted && ["backends", "stats", "acls", "rules", "waf"].includes(tab),
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
          <NodeConfigImportExportButtons nodeId={id} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setUpgradeOpen(true)}
            disabled={!nodeQ.data}
          >
            Upgrade
          </Button>
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
      {upgradeOpen && (
        <UpgradeModal
          nodeId={id}
          currentVersion={nodeQ.data?.haproxyVersion ?? null}
          onClose={() => setUpgradeOpen(false)}
        />
      )}

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
        <div className="space-y-4">
          <OverviewTab info={infoQ.data} loading={infoQ.isLoading} error={infoQ.error} />
          <TopologyView nodeId={id} onNavigate={(t) => setTab(t as Tab)} />
        </div>
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

      {tab === "acls" && (
        <AclsTab
          nodeId={id}
          frontends={feQ.data ?? []}
          backends={beQ.data ?? []}
          onChanged={refetch}
        />
      )}

      {tab === "rules" && (
        <RulesTab
          nodeId={id}
          frontends={feQ.data ?? []}
          backends={beQ.data ?? []}
          onChanged={refetch}
        />
      )}

      {tab === "waf" && (
        <WafBotsTab
          nodeId={id}
          frontends={feQ.data ?? []}
          backends={beQ.data ?? []}
          onChanged={refetch}
        />
      )}

      {tab === "logs" && <LogsTab nodeId={id} frontends={feQ.data ?? []} />}

      {tab === "maps" && <MapsTab nodeId={id} />}

      {tab === "certs" && <CertificatesTab nodeId={id} />}

      {tab === "userlists" && <UserlistsTab nodeId={id} />}

      {tab === "traffic" && <TrafficTab nodeId={id} />}

      {tab === "stick" && <StickTablesTab nodeId={id} />}

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

export const Route = createFileRoute("/nodes/$id")({ component: NodeDetail })
