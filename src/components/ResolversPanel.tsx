"use client"

import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { Label } from "#/components/ui/label"
import { dpGet, dpPost, dpPut, dpDelete, withTransaction } from "#/lib/dataplane/client"

type Resolver = {
  name: string
  nameservers?: { name?: string; address?: string }[]
  accepted_payload_size?: number
  hold_valid?: string
  hold_obsolete?: string
  hold_refresh?: string
  hold_retry?: string
}

export function ResolversPanel({ nodeId }: { nodeId: string }) {
  const qc = useQueryClient()
  const [newName, setNewName] = useState("")
  const [nsAddress, setNsAddress] = useState("")
  const [payloadSize, setPayloadSize] = useState("8192")

  const q = useQuery({
    queryKey: ["resolvers", nodeId],
    queryFn: () => dpGet<Resolver[]>(nodeId, "services/haproxy/configuration/resolvers"),
  })
  const resolvers = q.data ?? []

  const reload = () => qc.invalidateQueries({ queryKey: ["resolvers", nodeId] })

  const create = async () => {
    if (!newName.trim() || !nsAddress.trim()) return
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await dpPost(
            nodeId,
            `services/haproxy/configuration/resolvers?transaction_id=${tx}`,
            {
              name: newName.trim(),
              nameservers: [{ name: "ns1", address: nsAddress.trim() }],
              accepted_payload_size: Number(payloadSize) || 8192,
            },
            tx,
          )
        },
        {
          kind: "create",
          resource: "userlist", // closest existing kind; resolvers are rare edits
          target: newName.trim(),
          payload: { nameserver: nsAddress.trim() },
        },
      )
      toast.success(`Resolver "${newName.trim()}" created`)
      setNewName("")
      setNsAddress("")
      reload()
    } catch (e) {
      toast.error("Failed to create resolver", { description: (e as Error).message })
    }
  }

  const remove = async (name: string) => {
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await dpDelete(
            nodeId,
            `services/haproxy/configuration/resolvers/${encodeURIComponent(name)}?transaction_id=${tx}`,
            tx,
          )
        },
        { kind: "delete", resource: "userlist", target: name },
      )
      toast.success(`Resolver "${name}" deleted`)
      reload()
    } catch (e) {
      toast.error("Failed to delete resolver", { description: (e as Error).message })
    }
  }

  const editHold = async (r: Resolver, field: "hold_valid" | "hold_refresh", value: string) => {
    try {
      await dpPut(
        nodeId,
        `services/haproxy/configuration/resolvers/${encodeURIComponent(r.name)}`,
        { ...r, [field]: value },
      )
      toast.success(`Resolver "${r.name}" updated`)
      reload()
    } catch (e) {
      toast.error("Failed to update resolver", { description: (e as Error).message })
    }
  }

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 text-sm font-semibold">DNS resolvers</div>
      <div className="mb-2 space-y-2">
        {q.isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
        {resolvers.length === 0 && !q.isLoading && (
          <p className="text-xs text-muted-foreground">
            No resolvers configured. Backends can reference them via
            `server ... resolvers name` for FQDN servers.
          </p>
        )}
        {resolvers.map((r) => (
          <div key={r.name} className="rounded-md border border-border p-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{r.name}</span>
              <Button size="xs" variant="destructive" onClick={() => remove(r.name)}>
                Delete
              </Button>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              nameservers:{" "}
              {(r.nameservers ?? []).map((ns) => ns.address).join(", ") || "—"} ·
              payload {r.accepted_payload_size ?? "—"}
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs">
              <span>hold_valid:</span>
              <Input
                defaultValue={r.hold_valid ?? "10s"}
                onBlur={(e) => {
                  if (e.target.value !== (r.hold_valid ?? "10s"))
                    editHold(r, "hold_valid", e.target.value)
                }}
                className="h-7 w-20"
                aria-label={`hold_valid for ${r.name}`}
              />
              <span>hold_refresh:</span>
              <Input
                defaultValue={r.hold_refresh ?? "30s"}
                onBlur={(e) => {
                  if (e.target.value !== (r.hold_refresh ?? "30s"))
                    editHold(r, "hold_refresh", e.target.value)
                }}
                className="h-7 w-20"
                aria-label={`hold_refresh for ${r.name}`}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Name</Label>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="resolver name"
            className="w-36"
            aria-label="resolver name"
          />
        </div>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Nameserver</Label>
          <Input
            value={nsAddress}
            onChange={(e) => setNsAddress(e.target.value)}
            placeholder="10.0.0.1:53"
            className="w-40"
            aria-label="nameserver address"
          />
        </div>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Payload size</Label>
          <Input
            value={payloadSize}
            onChange={(e) => setPayloadSize(e.target.value)}
            className="w-20"
            aria-label="payload size"
          />
        </div>
        <Button onClick={create} disabled={!newName.trim() || !nsAddress.trim()}>
          Create resolver
        </Button>
      </div>
    </div>
  )
}
