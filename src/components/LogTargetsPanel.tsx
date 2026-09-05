"use client"

import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { Label } from "#/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select"
import { dpGet, dpPost, dpDelete, withTransaction } from "#/lib/dataplane/client"

type LogTarget = {
  log_target?: string
  address?: string
  port?: number
  facility?: string
  level?: string
  format?: string
}

export function LogTargetsPanel({
  nodeId,
  parentType,
  parentName,
}: {
  nodeId: string
  parentType: "frontends" | "backends"
  parentName: string
}) {
  const qc = useQueryClient()
  const [pending, setPending] = useState(false)
  const [form, setForm] = useState({
    address: "127.0.0.1",
    port: "514",
    facility: "local0",
    level: "info",
    format: "rfc5424",
  })

  const path = `services/haproxy/configuration/${parentType}/${encodeURIComponent(parentName)}/logs`
  const key = ["logs", nodeId, parentType, parentName]

  const logsQ = useQuery({
    queryKey: key,
    queryFn: () => dpGet<LogTarget[]>(nodeId, path),
    enabled: Boolean(parentName),
  })
  const logs = logsQ.data ?? []

  const reload = () => {
    qc.invalidateQueries({ queryKey: key })
  }

  const addLog = async () => {
    if (!form.address.trim()) return
    const body: LogTarget = { log_target: "address", address: form.address.trim() }
    const port = Number(form.port)
    if (Number.isInteger(port) && port >= 1 && port <= 65535) body.port = port
    if (form.facility) body.facility = form.facility
    if (form.level) body.level = form.level
    if (form.format) body.format = form.format
    setPending(true)
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await dpPost(nodeId, `${path}?transaction_id=${tx}`, body, tx)
        },
        {
          kind: "create",
          resource: "log",
          target: `log ${body.address}:${body.port ?? "-"}`,
          parent: `${parentType.replace(/s$/, "")}/${parentName}`,
          payload: body,
        },
      )
      toast.success("Log target added")
      reload()
    } catch (e) {
      toast.error("Failed to add log target", { description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  const removeLog = async (index: number) => {
    setPending(true)
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await dpDelete(nodeId, `${path}/${index}?transaction_id=${tx}`, tx)
        },
        {
          kind: "delete",
          resource: "log",
          target: `log:${logs[index]?.address ?? index}`,
          parent: `${parentType.replace(/s$/, "")}/${parentName}`,
          payload: logs[index],
        },
      )
      toast.success("Log target removed")
      reload()
    } catch (e) {
      toast.error("Failed to remove log target", { description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 text-sm font-semibold">Log targets</div>
      <div className="mb-2 space-y-1">
        {logsQ.isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
        {logs.length === 0 && !logsQ.isLoading && (
          <p className="text-xs text-muted-foreground">No log targets on this section.</p>
        )}
        {logs.map((l, i) => (
          <div key={i} className="flex items-center justify-between text-xs">
            <span className="font-mono">
              {l.facility ?? "local0"} {l.address}
              {l.port ? `:${l.port}` : ""} [{l.format ?? "rfc5424"} / {l.level ?? "info"}]
            </span>
            <Button
              size="xs"
              variant="destructive"
              disabled={pending}
              onClick={() => removeLog(i)}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Address</Label>
          <Input
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
            className="w-36"
            aria-label="log address"
          />
        </div>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Port</Label>
          <Input
            value={form.port}
            onChange={(e) => setForm({ ...form, port: e.target.value })}
            className="w-20"
            aria-label="log port"
          />
        </div>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Facility</Label>
          <Select value={form.facility} onValueChange={(v) => setForm({ ...form, facility: v ?? "local0" })}>
            <SelectTrigger className="w-[110px]" aria-label="log facility">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["local0", "local1", "local2", "local3", "local4", "local5", "local6", "local7", "daemon", "user"].map(
                (f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Level</Label>
          <Select value={form.level} onValueChange={(v) => setForm({ ...form, level: v ?? "info" })}>
            <SelectTrigger className="w-[100px]" aria-label="log level">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["emerg", "alert", "crit", "err", "warning", "notice", "info", "debug"].map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={addLog} disabled={pending || !parentName}>
          {pending ? "Working…" : "Add log target"}
        </Button>
      </div>
    </div>
  )
}
