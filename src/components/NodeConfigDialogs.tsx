"use client"

import { useEffect, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "#/components/ui/button"
import { Modal } from "#/components/Modal"
import {
  NumberField,
  NumberFieldGroup,
  NumberFieldInput,
  NumberFieldDecrement,
  NumberFieldIncrement,
} from "#/components/reui/number-field"
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteContent,
  AutocompleteList,
  AutocompleteItem,
} from "#/components/reui/autocomplete"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select"
import { withTransaction, dpPost, dpPut, dpDelete, dpGet } from "#/lib/dataplane/client"
import {
  frontendInputSchema,
  backendInputSchema,
  serverInputSchema,
  fieldErrors,
  HAPROXY_MODES,
  BALANCE_ALGORITHMS,
} from "#/lib/schemas"
import type { Backend, Frontend, Server } from "#/lib/types"

const inputCls =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"

function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="text-xs text-destructive">{message}</p>
}

function ModeSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as string)}>
      <SelectTrigger className="w-full" aria-label="mode">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {HAPROXY_MODES.map((m) => (
          <SelectItem key={m} value={m}>
            {m}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function FrontendDialog({
  open,
  nodeId,
  edit,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean
  nodeId: string
  /** When set, the dialog edits this frontend instead of creating one. */
  edit?: Frontend | null
  onClose: () => void
  onCreated: () => void
  onError: (m: string | null) => void
}) {
  const [form, setForm] = useState({
    name: "",
    mode: "http",
    default_backend: "",
    address: "*",
    port: 80,
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  useEffect(() => {
    if (open) {
      const firstBind = Array.isArray(edit?.bind) ? edit.bind[0] : undefined
      setForm({
        name: edit?.name ?? "",
        mode: edit?.mode ?? "http",
        default_backend: edit?.default_backend ?? "",
        address: firstBind?.address ?? "*",
        port: firstBind?.port ?? 80,
      })
      setErrors({})
    }
  }, [open, edit])
  const beQ = useQuery({
    queryKey: ["fe-backends", nodeId],
    queryFn: () => dpGet<Backend[]>(nodeId, "services/haproxy/configuration/backends"),
    enabled: mounted,
  })
  const backendNames = (beQ.data ?? []).map((b) => b.name)
  const mut = useMutation({
    mutationFn: () => {
      if (edit) {
        // Replace semantics (full_section=false): only section fields are
        // edited; binds stay untouched on the node.
        return withTransaction(
          nodeId,
          async (tx) => {
            await dpPut(
              nodeId,
              `services/haproxy/configuration/frontends/${encodeURIComponent(edit.name)}`,
              {
                name: edit.name,
                mode: form.mode,
                default_backend: form.default_backend || undefined,
              },
              tx,
            )
          },
          {
            kind: "update",
            resource: "frontend",
            target: edit.name,
            payload: {
              mode: form.mode,
              default_backend: form.default_backend || undefined,
            },
          },
        )
      }
      const parsed = frontendInputSchema.safeParse({
        name: form.name,
        mode: form.mode,
        default_backend: form.default_backend || undefined,
        bind: [{ address: form.address, port: form.port }],
      })
      if (!parsed.success) {
        setErrors(fieldErrors(parsed.error))
        throw new Error("Please fix the highlighted fields")
      }
      setErrors({})
      return withTransaction(
        nodeId,
        async (tx) => {
          await dpPost(
            nodeId,
            "services/haproxy/configuration/frontends",
            parsed.data,
            tx,
          )
        },
        {
          kind: "create",
          resource: "frontend",
          target: parsed.data.name,
          payload: parsed.data,
        },
      )
    },
    onSuccess: () => {
      toast.success(
        edit ? `Frontend "${edit.name}" updated` : `Frontend "${form.name}" created`,
      )
      onCreated()
      onClose()
    },
    onError: (e) => {
      if ((e as Error).message !== "Please fix the highlighted fields")
        onError((e as Error).message)
    },
  })
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={edit ? `Edit frontend ${edit.name}` : "New frontend"}
    >
      <div className="flex flex-col gap-3">
        <div>
          <input
            className={inputCls}
            placeholder="name"
            value={form.name}
            disabled={Boolean(edit)}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            aria-invalid={Boolean(errors.name)}
          />
          <FieldError message={errors.name} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <ModeSelect
            value={form.mode}
            onChange={(v) => setForm({ ...form, mode: v })}
          />
          <Autocomplete
            items={backendNames}
            value={form.default_backend}
            onValueChange={(v) => setForm({ ...form, default_backend: v })}
          >
            <AutocompleteInput placeholder="default_backend (optional)" />
            <AutocompleteContent>
              <AutocompleteList>
                {backendNames.map((n) => (
                  <AutocompleteItem key={n} value={n}>
                    {n}
                  </AutocompleteItem>
                ))}
              </AutocompleteList>
            </AutocompleteContent>
          </Autocomplete>
        </div>
        {!edit && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <input
                className={inputCls}
                placeholder="bind address"
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
                aria-invalid={Boolean(errors["bind.0.address"])}
              />
              <FieldError message={errors["bind.0.address"] ?? errors.bind} />
            </div>
            <div>
              <NumberField
                value={form.port}
                onValueChange={(v) => setForm({ ...form, port: v ?? 0 })}
                min={1}
                max={65535}
              >
                <NumberFieldGroup>
                  <NumberFieldDecrement />
                  <NumberFieldInput />
                  <NumberFieldIncrement />
                </NumberFieldGroup>
              </NumberField>
              <FieldError message={errors["bind.0.port"]} />
            </div>
          </div>
        )}
        {edit && (
          <p className="text-xs text-muted-foreground">
            Edit mode changes mode/default_backend only. Binds on the node are
            left untouched.
          </p>
        )}
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
            disabled={mut.isPending || (!edit && !form.name)}
          >
            {mut.isPending ? "Saving…" : edit ? "Save changes" : "Create"}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function BackendDialog({
  open,
  nodeId,
  edit,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean
  nodeId: string
  /** When set, the dialog edits this backend instead of creating one. */
  edit?: Backend | null
  onClose: () => void
  onCreated: () => void
  onError: (m: string | null) => void
}) {
  const [form, setForm] = useState({
    name: "",
    mode: "http",
    algorithm: "roundrobin",
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    if (open) {
      setForm({
        name: edit?.name ?? "",
        mode: edit?.mode ?? "http",
        algorithm: edit?.balance?.algorithm ?? "roundrobin",
      })
      setErrors({})
    }
  }, [open, edit])
  const mut = useMutation({
    mutationFn: () => {
      if (edit) {
        // Replace semantics (full_section=false): servers untouched.
        return withTransaction(
          nodeId,
          async (tx) => {
            await dpPut(
              nodeId,
              `services/haproxy/configuration/backends/${encodeURIComponent(edit.name)}`,
              {
                name: edit.name,
                mode: form.mode,
                balance: { algorithm: form.algorithm },
              },
              tx,
            )
          },
          {
            kind: "update",
            resource: "backend",
            target: edit.name,
            payload: { mode: form.mode, balance: { algorithm: form.algorithm } },
          },
        )
      }
      const parsed = backendInputSchema.safeParse(form)
      if (!parsed.success) {
        setErrors(fieldErrors(parsed.error))
        throw new Error("Please fix the highlighted fields")
      }
      setErrors({})
      return withTransaction(
        nodeId,
        async (tx) => {
          await dpPost(
            nodeId,
            "services/haproxy/configuration/backends",
            parsed.data,
            tx,
          )
        },
        {
          kind: "create",
          resource: "backend",
          target: parsed.data.name,
          payload: parsed.data,
        },
      )
    },
    onSuccess: () => {
      toast.success(
        edit ? `Backend "${edit.name}" updated` : `Backend "${form.name}" created`,
      )
      onCreated()
      onClose()
    },
    onError: (e) => {
      if ((e as Error).message !== "Please fix the highlighted fields")
        onError((e as Error).message)
    },
  })
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={edit ? `Edit backend ${edit.name}` : "New backend"}
    >
      <div className="flex flex-col gap-3">
        <div>
          <input
            className={inputCls}
            placeholder="name"
            value={form.name}
            disabled={Boolean(edit)}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            aria-invalid={Boolean(errors.name)}
          />
          <FieldError message={errors.name} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <ModeSelect
            value={form.mode}
            onChange={(v) => setForm({ ...form, mode: v })}
          />
          <Select
            value={form.algorithm}
            onValueChange={(v) => setForm({ ...form, algorithm: v as string })}
          >
            <SelectTrigger className="w-full" aria-label="balance algorithm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BALANCE_ALGORITHMS.map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {edit && (
          <p className="text-xs text-muted-foreground">
            Edit mode changes mode/balance only. Servers on the node are left
            untouched.
          </p>
        )}
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
            disabled={mut.isPending || (!edit && !form.name)}
          >
            {mut.isPending ? "Saving…" : edit ? "Save changes" : "Create"}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function ServersModal({
  nodeId,
  backend,
  onClose,
  onChanged,
  onError,
}: {
  nodeId: string
  backend: Backend
  onClose: () => void
  onChanged: () => void
  onError: (m: string | null) => void
}) {
  const [servers, setServers] = useState<Server[] | null>(null)
  const [form, setForm] = useState({
    name: "",
    address: "",
    port: 80,
    weight: 100,
    check: false,
  })
  const [errors, setErrors] = useState<Record<string, string>>({})

  const load = useMutation({
    mutationFn: () =>
      dpGet<Server[]>(
        nodeId,
        `services/haproxy/configuration/backends/${encodeURIComponent(backend.name)}/servers`,
      ),
    onSuccess: (s) => setServers(s ?? []),
    onError: (e) => onError((e as Error).message),
  })

  const addMut = useMutation({
    mutationFn: () => {
      const parsed = serverInputSchema.safeParse({
        name: form.name,
        address: form.address,
        port: form.port,
        weight: form.weight,
        check: form.check ? "enabled" : "disabled",
      })
      if (!parsed.success) {
        setErrors(fieldErrors(parsed.error))
        throw new Error("Please fix the highlighted fields")
      }
      setErrors({})
      return withTransaction(
        nodeId,
        async (tx) => {
          await dpPost(
            nodeId,
            `services/haproxy/configuration/backends/${encodeURIComponent(backend.name)}/servers`,
            parsed.data,
            tx,
          )
        },
        {
          kind: "create",
          resource: "server",
          target: parsed.data.name,
          parent: backend.name,
          payload: parsed.data,
        },
      )
    },
    onSuccess: () => {
      setForm({ name: "", address: "", port: 80, weight: 100, check: false })
      onChanged()
      load.mutate()
    },
    onError: (e) => {
      if ((e as Error).message !== "Please fix the highlighted fields")
        onError((e as Error).message)
    },
  })

  const delMut = useMutation({
    mutationFn: (name: string) =>
      withTransaction(nodeId, async (tx) => {
        await dpDelete(
          nodeId,
          `services/haproxy/configuration/backends/${encodeURIComponent(backend.name)}/servers/${encodeURIComponent(name)}`,
          tx,
        )
      }),
    onSuccess: () => {
      onChanged()
      load.mutate()
    },
    onError: (e) => onError((e as Error).message),
  })

  return (
    <Modal open onClose={onClose} title={`Servers in ${backend.name}`}>
      <div className="flex flex-col gap-3">
        <button
          className="self-start text-xs text-primary hover:underline"
          onClick={() => load.mutate()}
        >
          {servers ? "Refresh" : "Load servers"}
        </button>

        <div className="rounded-md border border-border">
          {(servers ?? []).map((s) => (
            <div
              key={s.name}
              className="flex items-center justify-between border-b border-border px-3 py-2 text-sm last:border-0"
            >
              <span>
                <span className="font-medium">{s.name}</span>{" "}
                <span className="text-muted-foreground">
                  {s.address}:{s.port} (w{s.weight})
                </span>
              </span>
              <Button size="sm" variant="destructive" onClick={() => delMut.mutate(s.name)}>
                Remove
              </Button>
            </div>
          ))}
          {servers && servers.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted-foreground">No servers</div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <input
              className={inputCls}
              placeholder="server name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              aria-invalid={Boolean(errors.name)}
            />
            <FieldError message={errors.name} />
          </div>
          <div>
            <input
              className={inputCls}
              placeholder="address"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              aria-invalid={Boolean(errors.address)}
            />
            <FieldError message={errors.address} />
          </div>
          <div>
            <NumberField
              value={form.port}
              onValueChange={(v) => setForm({ ...form, port: v ?? 0 })}
              min={1}
              max={65535}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement />
                <NumberFieldInput />
                <NumberFieldIncrement />
              </NumberFieldGroup>
            </NumberField>
            <FieldError message={errors.port} />
          </div>
          <div>
            <NumberField
              value={form.weight}
              onValueChange={(v) => setForm({ ...form, weight: v ?? 0 })}
              min={0}
              max={256}
            >
              <NumberFieldGroup>
                <NumberFieldDecrement />
                <NumberFieldInput />
                <NumberFieldIncrement />
              </NumberFieldGroup>
            </NumberField>
            <FieldError message={errors.weight} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.check}
            onChange={(e) => setForm({ ...form, check: e.target.checked })}
          />
          Health check
        </label>
        {addMut.isError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {(addMut.error as Error).message}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            onClick={() => addMut.mutate()}
            disabled={addMut.isPending || !form.name || !form.address}
          >
            {addMut.isPending ? "Adding…" : "Add server"}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
