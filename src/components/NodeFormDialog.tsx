"use client"

import { useEffect, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { Modal } from "./Modal"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { Label } from "#/components/ui/label"
import { nodeInputSchema, fieldErrors } from "#/lib/schemas"
import type { NodeRow } from "#/lib/types"

const field =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"

const emptyForm = {
  name: "",
  apiUrl: "",
  apiUser: "admin",
  apiPass: "admin",
  group: "",
}

export function NodeFormDialog({
  open,
  onClose,
  onSaved,
  node,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  /** When set, the dialog edits an existing node instead of creating one. */
  node?: NodeRow | null
}) {
  const editing = Boolean(node)
  const [form, setForm] = useState(emptyForm)
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (open) {
      setForm(
        node
          ? {
              name: node.name,
              apiUrl: node.apiUrl,
              apiUser: node.apiUser,
              apiPass: node.apiPass,
              group: node.group ?? "",
            }
          : emptyForm,
      )
      setErrors({})
    }
  }, [open, node])

  const mut = useMutation({
    mutationFn: async () => {
      const parsed = nodeInputSchema.safeParse(form)
      if (!parsed.success) {
        setErrors(fieldErrors(parsed.error))
        throw new Error("Please fix the highlighted fields")
      }
      setErrors({})
      const res = await fetch(
        editing ? `/api/nodes/${node!.id}` : "/api/nodes",
        {
          method: editing ? "PUT" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(form),
        },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        if (j.fields) setErrors(j.fields)
        throw new Error(j.error ?? "failed to save node")
      }
      return res.json()
    },
    onSuccess: () => {
      onSaved()
      onClose()
    },
  })

  const err = (k: string) =>
    errors[k] ? (
      <p className="mt-1 text-xs text-destructive">{errors[k]}</p>
    ) : null

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? `Edit node ${node!.name}` : "Register HAProxy node"}
    >
      <div className="flex flex-col gap-3">
        <div>
          <Label className="mb-1 block">Name</Label>
          <Input
            className={field}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="edge-1"
            aria-invalid={Boolean(errors.name)}
          />
          {err("name")}
        </div>
        <div>
          <Label className="mb-1 block">Data Plane API URL</Label>
          <Input
            className={field}
            value={form.apiUrl}
            onChange={(e) => setForm({ ...form, apiUrl: e.target.value })}
            placeholder="http://localhost:5555"
            aria-invalid={Boolean(errors.apiUrl)}
          />
          {err("apiUrl")}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="mb-1 block">API User</Label>
            <Input
              className={field}
              value={form.apiUser}
              onChange={(e) => setForm({ ...form, apiUser: e.target.value })}
            />
            {err("apiUser")}
          </div>
          <div>
            <Label className="mb-1 block">API Password</Label>
            <Input
              className={field}
              type="password"
              value={form.apiPass}
              onChange={(e) => setForm({ ...form, apiPass: e.target.value })}
            />
            {err("apiPass")}
          </div>
        </div>
        <div>
          <Label className="mb-1 block">Group (optional)</Label>
          <Input
            className={field}
            value={form.group}
            onChange={(e) => setForm({ ...form, group: e.target.value })}
            placeholder="e.g. eu-prod"
          />
          {err("group")}
        </div>
        {mut.isError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {(mut.error as Error).message}
          </div>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => mut.mutate()}
            disabled={mut.isPending || !form.name || !form.apiUrl}
          >
            {mut.isPending ? "Saving…" : editing ? "Save changes" : "Register"}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
