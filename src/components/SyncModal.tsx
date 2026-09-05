"use client"

import { useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { Modal } from "./Modal"
import { Button } from "#/components/ui/button"
import { Checkbox } from "#/components/ui/checkbox"
import { Label } from "#/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select"
import { withTransaction, dpGet, dpPost, dpDelete } from "#/lib/dataplane/client"
import { normalizeFrontends, normalizeBackends, serversOf } from "#/lib/normalize"
import type { NodeRow, Frontend, Backend } from "#/lib/types"

type SyncResult = {
  node: string
  created: string[]
  skipped: string[]
  error?: string
}

function toggleSet(set: Set<string>, value: string): Set<string> {
  const next = new Set(set)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

export function SyncModal({
  nodeId,
  onClose,
}: {
  nodeId: string
  onClose: () => void
}) {
  const [feSel, setFeSel] = useState<Set<string>>(new Set())
  const [beSel, setBeSel] = useState<Set<string>>(new Set())
  const [includeServers, setIncludeServers] = useState(true)
  const [targets, setTargets] = useState<Set<string>>(new Set())
  const [conflict, setConflict] = useState<"skip" | "overwrite">("skip")
  const [results, setResults] = useState<SyncResult[] | null>(null)

  const nodesQ = useQuery({
    queryKey: ["nodes"],
    queryFn: async () => {
      const res = await fetch("/api/nodes")
      if (!res.ok) throw new Error("failed to load nodes")
      return (await res.json()) as NodeRow[]
    },
  })
  const feQ = useQuery({
    queryKey: ["sync-frontends", nodeId],
    queryFn: () => dpGet<Frontend[]>(nodeId, "services/haproxy/configuration/frontends"),
  })
  const beQ = useQuery({
    queryKey: ["sync-backends", nodeId],
    queryFn: () => dpGet<Backend[]>(nodeId, "services/haproxy/configuration/backends"),
  })

  const frontends = normalizeFrontends(feQ.data).filter((f) => !f.name.startsWith("_"))
  const backends = normalizeBackends(beQ.data).filter((b) => !b.name.startsWith("_"))
  const otherNodes = (nodesQ.data ?? []).filter((n) => n.id !== nodeId)

  const syncMut = useMutation({
    mutationFn: async () => {
      const fes = frontends.filter((f) => feSel.has(f.name))
      const bes = backends.filter((b) => beSel.has(b.name))
      const out: SyncResult[] = []
      for (const t of targets) {
        const r: SyncResult = { node: t, created: [], skipped: [] }
        try {
          const [tFes, tBes] = await Promise.all([
            dpGet<Frontend[]>(t, "services/haproxy/configuration/frontends"),
            dpGet<Backend[]>(t, "services/haproxy/configuration/backends"),
          ])
          const tFeNames = new Set(tFes.map((f) => f.name))
          const tBeNames = new Set(tBes.map((b) => b.name))

          await withTransaction(
            t,
            async (tx) => {
              for (const b of bes) {
                const backendExists = tBeNames.has(b.name)
                if (backendExists && conflict === "skip") {
                  r.skipped.push(`backend/${b.name}`)
                } else {
                  if (backendExists) {
                    await dpDelete(
                      t,
                      `services/haproxy/configuration/backends/${encodeURIComponent(b.name)}`,
                      tx,
                    )
                  }
                  const { servers: _, ...bePayload } = b
                  await dpPost(t, "services/haproxy/configuration/backends", bePayload, tx)
                  r.created.push(`backend/${b.name}`)
                }
                if (includeServers) {
                  const targetSrv = backendExists && conflict === "skip"
                    ? await dpGet<{ name: string }[]>(
                        t,
                        `services/haproxy/configuration/backends/${encodeURIComponent(b.name)}/servers`,
                      )
                    : []
                  const targetSrvNames = new Set(targetSrv.map((s) => s.name))
                  for (const s of serversOf(b)) {
                    if (targetSrvNames.has(s.name)) {
                      r.skipped.push(`server/${b.name}/${s.name}`)
                      continue
                    }
                    await dpPost(
                      t,
                      `services/haproxy/configuration/backends/${encodeURIComponent(b.name)}/servers`,
                      s,
                      tx,
                    )
                    r.created.push(`server/${b.name}/${s.name}`)
                  }
                }
              }
              for (const f of fes) {
                if (tFeNames.has(f.name)) {
                  if (conflict === "skip") {
                    r.skipped.push(`frontend/${f.name}`)
                    continue
                  }
                  await dpDelete(
                    t,
                    `services/haproxy/configuration/frontends/${encodeURIComponent(f.name)}`,
                    tx,
                  )
                }
                await dpPost(t, "services/haproxy/configuration/frontends", f, tx)
                r.created.push(`frontend/${f.name}`)
              }
            },
            [
              ...bes.flatMap((b) => [
                {
                  kind: "create" as const,
                  resource: "backend" as const,
                  target: b.name,
                  payload: { name: b.name, mode: b.mode, balance: b.balance },
                },
                ...(includeServers
                  ? serversOf(b).map((s) => ({
                      kind: "create" as const,
                      resource: "server" as const,
                      target: s.name,
                      parent: b.name,
                      payload: s,
                    }))
                  : []),
              ]),
              ...fes.map((f) => ({
                kind: "create" as const,
                resource: "frontend" as const,
                target: f.name,
                payload: f,
              })),
            ],
          )
        } catch (e) {
          r.error = (e as Error).message
        }
        out.push(r)
      }
      return out
    },
    onSuccess: (rs) => {
      setResults(rs)
      const ok = rs.filter((r) => !r.error).length
      toast.success(`Sync finished: ${ok}/${rs.length} nodes updated`)
    },
    onError: (e) =>
      toast.error("Sync failed", { description: (e as Error).message }),
  })

  const canSync = (feSel.size + beSel.size > 0) && targets.size > 0 && !syncMut.isPending

  return (
    <Modal open onClose={onClose} title="Sync configuration to nodes" wide>
      {results ? (
        <div className="flex flex-col gap-3">
          {results.map((r) => (
            <div key={r.node} className="rounded-md border border-border p-3 text-sm">
              <div className="font-medium">
                {nodesQ.data?.find((n) => n.id === r.node)?.name ?? r.node}
                {r.error ? (
                  <span className="ml-2 text-destructive">failed</span>
                ) : (
                  <span className="ml-2 text-success">updated</span>
                )}
              </div>
              {r.created.length > 0 && (
                <div className="mt-1 text-muted-foreground">
                  Created: {r.created.join(", ")}
                </div>
              )}
              {r.skipped.length > 0 && (
                <div className="mt-1 text-muted-foreground">
                  Skipped (already exist): {r.skipped.join(", ")}
                </div>
              )}
              {r.error && <div className="mt-1 text-destructive">{r.error}</div>}
            </div>
          ))}
          <div className="flex justify-end">
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <Label className="mb-2 block font-medium">Resources from this node</Label>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border border-border p-2">
                <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                  Frontends
                </div>
                {feQ.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
                {frontends.length === 0 && !feQ.isLoading && (
                  <p className="text-sm text-muted-foreground">None</p>
                )}
                {frontends.map((f) => (
                  <label key={f.name} className="flex items-center gap-2 py-0.5 text-sm">
                    <Checkbox
                      checked={feSel.has(f.name)}
                      onCheckedChange={() => setFeSel((s) => toggleSet(s, f.name))}
                    />
                    {f.name}
                  </label>
                ))}
              </div>
              <div className="rounded-md border border-border p-2">
                <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                  Backends
                </div>
                {beQ.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
                {backends.length === 0 && !beQ.isLoading && (
                  <p className="text-sm text-muted-foreground">None</p>
                )}
                {backends.map((b) => (
                  <label key={b.name} className="flex items-center gap-2 py-0.5 text-sm">
                    <Checkbox
                      checked={beSel.has(b.name)}
                      onCheckedChange={() => setBeSel((s) => toggleSet(s, b.name))}
                    />
                    {b.name}
                    <span className="text-muted-foreground">
                      ({serversOf(b).length} servers)
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <Checkbox
                checked={includeServers}
                onCheckedChange={(v) => setIncludeServers(v === true)}
              />
              Include backend servers
            </label>
          </div>

          <div>
            <Label className="mb-2 block font-medium">Target nodes</Label>
            <div className="grid grid-cols-2 gap-1">
              {otherNodes.map((n) => (
                <label key={n.id} className="flex items-center gap-2 py-0.5 text-sm">
                  <Checkbox
                    checked={targets.has(n.id)}
                    onCheckedChange={() => setTargets((s) => toggleSet(s, n.id))}
                  />
                  {n.name}
                </label>
              ))}
              {otherNodes.length === 0 && (
                <p className="text-sm text-muted-foreground">No other nodes registered</p>
              )}
            </div>
          </div>

          <div>
            <Label className="mb-1 block font-medium">If target already has the same name</Label>
            <Select value={conflict} onValueChange={(v) => setConflict(v as "skip" | "overwrite")}>
              <SelectTrigger className="w-full" aria-label="conflict strategy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="skip">Skip existing items</SelectItem>
                <SelectItem value="overwrite">Overwrite (delete + recreate)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="mt-1 flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => syncMut.mutate()} disabled={!canSync}>
              {syncMut.isPending
                ? "Syncing…"
                : `Sync to ${targets.size} node${targets.size === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
