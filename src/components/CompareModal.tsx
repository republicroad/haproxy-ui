"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Modal } from "./Modal"
import { Button } from "./ui/button"
import { Label } from "./ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select"
import type { NodeRow } from "#/lib/types"

type DiffResult = {
  a: { name: string }
  b: { name: string }
  identical: boolean
  frontends: {
    onlyInA: string[]
    onlyInB: string[]
    changed: { name: string; fields: string[] }[]
  }
  backends: {
    onlyInA: string[]
    onlyInB: string[]
    changed: { name: string; fields: string[]; serverDiff: { onlyInA: string[]; onlyInB: string[] } | null }[]
  }
}

function Section({
  title,
  onlyInA,
  onlyInB,
  changed,
  aName,
  bName,
}: {
  title: string
  onlyInA: string[]
  onlyInB: string[]
  changed: { name: string; fields: string[] }[]
  aName: string
  bName: string
}) {
  const empty =
    onlyInA.length === 0 && onlyInB.length === 0 && changed.length === 0
  return (
    <div>
      <h4 className="mb-1 text-sm font-semibold">{title}</h4>
      {empty && <p className="text-sm text-muted-foreground">Identical</p>}
      {onlyInA.length > 0 && (
        <p className="text-sm">
          <span className="font-medium">{aName} only:</span>{" "}
          <span className="text-destructive">{onlyInA.join(", ")}</span>
        </p>
      )}
      {onlyInB.length > 0 && (
        <p className="text-sm">
          <span className="font-medium">{bName} only:</span>{" "}
          <span className="text-destructive">{onlyInB.join(", ")}</span>
        </p>
      )}
      {changed.map((c) => (
        <p key={c.name} className="text-sm">
          <span className="font-medium">{c.name}:</span> differs in{" "}
          <span className="text-warning">{c.fields.join(", ")}</span>
        </p>
      ))}
    </div>
  )
}

export function CompareModal({
  nodes,
  onClose,
}: {
  nodes: NodeRow[]
  onClose: () => void
}) {
  const [aId, setAId] = useState(nodes[0]?.id ?? "")
  const [bId, setBId] = useState(nodes[1]?.id ?? "")

  const q = useQuery({
    queryKey: ["node-diff", aId, bId],
    queryFn: async (): Promise<DiffResult> => {
      const res = await fetch(`/api/nodes/diff?a=${aId}&b=${bId}`)
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error ?? "diff failed")
      return j
    },
    enabled: Boolean(aId && bId && aId !== bId),
  })

  return (
    <Modal open onClose={onClose} title="Compare node configurations" wide>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Node A</Label>
            <Select value={aId} onValueChange={(v) => setAId(v ?? "")}>
              <SelectTrigger className="w-full" aria-label="node A">
                <SelectValue placeholder="pick" />
              </SelectTrigger>
              <SelectContent>
                {nodes.map((n) => (
                  <SelectItem key={n.id} value={n.id}>
                    {n.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Node B</Label>
            <Select value={bId} onValueChange={(v) => setBId(v ?? "")}>
              <SelectTrigger className="w-full" aria-label="node B">
                <SelectValue placeholder="pick" />
              </SelectTrigger>
              <SelectContent>
                {nodes.map((n) => (
                  <SelectItem key={n.id} value={n.id}>
                    {n.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {aId === bId && (
          <p className="text-sm text-muted-foreground">Pick two different nodes.</p>
        )}

        {q.isFetching && (
          <p className="text-sm text-muted-foreground">Comparing…</p>
        )}
        {q.isError && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}

        {q.data && (
          <div className="space-y-4 rounded-lg border border-border p-3">
            {q.data.identical ? (
              <p className="text-sm font-medium text-success">
                Configurations are identical.
              </p>
            ) : (
              <>
                <Section
                  title="Frontends"
                  onlyInA={q.data.frontends.onlyInA}
                  onlyInB={q.data.frontends.onlyInB}
                  changed={q.data.frontends.changed}
                  aName={q.data.a.name}
                  bName={q.data.b.name}
                />
                <Section
                  title="Backends"
                  onlyInA={q.data.backends.onlyInA}
                  onlyInB={q.data.backends.onlyInB}
                  changed={q.data.backends.changed.map((c) => ({
                    name: c.name,
                    fields: [
                      ...c.fields,
                      ...(c.serverDiff
                        ? [
                            `servers (A only: ${c.serverDiff.onlyInA.join(", ") || "—"}; B only: ${c.serverDiff.onlyInB.join(", ") || "—"})`,
                          ]
                        : []),
                    ],
                  }))}
                  aName={q.data.a.name}
                  bName={q.data.b.name}
                />
              </>
            )}
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  )
}
