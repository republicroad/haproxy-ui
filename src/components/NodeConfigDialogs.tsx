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
  const [editBinds, setEditBinds] = useState<
    { address: string; port: number }[] | null
  >(null)
  const [confirmRebuild, setConfirmRebuild] = useState(false)
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
      setEditBinds(
        edit && Array.isArray(edit.bind)
          ? edit.bind.map((b) => ({ address: b.address, port: b.port }))
          : null,
      )
      setConfirmRebuild(false)
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
        const bindsChanged =
          editBinds !== null &&
          JSON.stringify(editBinds) !==
            JSON.stringify(
              (Array.isArray(edit.bind) ? edit.bind : []).map((b) => ({
                address: b.address,
                port: b.port,
              })),
            )
        if (bindsChanged && !confirmRebuild) {
          // first click arms the destructive rebuild confirmation
          setConfirmRebuild(true)
          throw new Error("Confirm section rebuild to apply bind changes")
        }
        // With bind edits: full-section replace (GET round-trip then PUT
        // with full_section=true). Otherwise: section fields only.
        return withTransaction(
          nodeId,
          async (tx) => {
            if (bindsChanged) {
              const full = await dpGet<Frontend>(
                nodeId,
                `services/haproxy/configuration/frontends/${encodeURIComponent(edit.name)}?full_section=true`,
              )
              await dpPut(
                nodeId,
                `services/haproxy/configuration/frontends/${encodeURIComponent(edit.name)}?full_section=true`,
                {
                  ...full,
                  name: edit.name,
                  mode: form.mode,
                  default_backend: form.default_backend || undefined,
                  binds: Object.fromEntries(
                    (editBinds ?? []).map((b) => [
                      `${b.address}:${b.port}`,
                      { address: b.address, port: b.port },
                    ]),
                  ),
                },
                tx,
              )
            } else {
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
            }
          },
          {
            kind: "update",
            resource: "frontend",
            target: edit.name,
            payload: {
              mode: form.mode,
              default_backend: form.default_backend || undefined,
              ...(bindsChanged ? { binds: editBinds } : {}),
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
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Binds</div>
            {(editBinds ?? []).map((b, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  className={`${inputCls} flex-1`}
                  value={b.address}
                  onChange={(e) => {
                    const next = [...(editBinds ?? [])]
                    next[i] = { ...b, address: e.target.value }
                    setEditBinds(next)
                  }}
                  aria-label={`bind ${i + 1} address`}
                />
                <NumberField
                  value={b.port}
                  onValueChange={(v) => {
                    const next = [...(editBinds ?? [])]
                    next[i] = { ...b, port: v ?? 0 }
                    setEditBinds(next)
                  }}
                  min={1}
                  max={65535}
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement />
                    <NumberFieldInput />
                    <NumberFieldIncrement />
                  </NumberFieldGroup>
                </NumberField>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setEditBinds((prev) => (prev ?? []).filter((_, j) => j !== i))
                  }
                  aria-label={`remove bind ${i + 1}`}
                >
                  ✕
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditBinds([...(editBinds ?? []), { address: "*", port: 80 }])}
            >
              Add bind
            </Button>
            {confirmRebuild && (
              <p className="text-xs text-destructive">
                Bind changes replace the whole frontend section on the node
                (unlisted options are removed). Click Confirm rebuild to apply.
              </p>
            )}
          </div>
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
            variant={edit && confirmRebuild ? "destructive" : "default"}
          >
            {mut.isPending
              ? "Saving…"
              : edit
                ? confirmRebuild
                  ? "Confirm rebuild"
                  : "Save changes"
                : "Create"}
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
  const [editingServer, setEditingServer] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({
    check: false,
    interval: "2000",
    fall: "3",
    rise: "2",
    weight: "100",
  })
  const [editErr, setEditErr] = useState<string | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [form, setForm] = useState({
    name: "",
    address: "",
    port: 80,
    weight: 100,
    check: false,
  })
  const [errors, setErrors] = useState<Record<string, string>>({})

  const saveServerCheck = async (s: Server) => {
    setEditSaving(true)
    setEditErr(null)
    const interval = Number(editForm.interval)
    const fall = Number(editForm.fall)
    const rise = Number(editForm.rise)
    const weight = Number(editForm.weight)
    if (
      (editForm.interval && (!Number.isInteger(interval) || interval < 250)) ||
      (editForm.fall && (!Number.isInteger(fall) || fall < 1)) ||
      (editForm.rise && (!Number.isInteger(rise) || rise < 1)) ||
      (!Number.isInteger(weight) || weight < 0 || weight > 256)
    ) {
      setEditErr("invalid values: interval ≥ 250ms, fall/rise ≥ 1, weight 0-256")
      setEditSaving(false)
      return
    }
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await dpPut(
            nodeId,
            `services/haproxy/configuration/backends/${encodeURIComponent(backend.name)}/servers/${encodeURIComponent(s.name)}`,
            {
              check: editForm.check ? "enabled" : "disabled",
              ...(editForm.check && editForm.interval
                ? { check_interval: interval }
                : {}),
              ...(editForm.check && editForm.fall ? { check_fall: fall } : {}),
              ...(editForm.check && editForm.rise ? { check_rise: rise } : {}),
              weight,
            },
            tx,
          )
        },
        {
          kind: "update",
          resource: "server",
          target: s.name,
          parent: backend.name,
          payload: {
            check: editForm.check ? "enabled" : "disabled",
            check_interval: interval,
            check_fall: fall,
            check_rise: rise,
            weight,
          },
        },
      )
      toast.success(`Check params updated for "${s.name}"`)
      setEditingServer(null)
      load.mutate()
      onChanged()
    } catch (e) {
      setEditErr((e as Error).message)
    } finally {
      setEditSaving(false)
    }
  }

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
              className="border-b border-border px-3 py-2 text-sm last:border-0"
            >
              <div className="flex items-center justify-between">
                <span>
                  <span className="font-medium">{s.name}</span>{" "}
                  <span className="text-muted-foreground">
                    {s.address}:{s.port} (w{s.weight})
                    {s.check === "enabled" && (
                      <span className="ml-1 text-xs">
                        · check {s.check_interval ? `${s.check_interval}ms` : "default"}
                        {` fall=${s.check_fall ?? 3} rise=${s.check_rise ?? 2}`}
                      </span>
                    )}
                  </span>
                </span>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setEditingServer(editingServer === s.name ? null : s.name)
                    }
                  >
                    {editingServer === s.name ? "Close" : "Edit"}
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => delMut.mutate(s.name)}>
                    Remove
                  </Button>
                </div>
              </div>
              {editingServer === s.name && (
                <div className="mt-2 space-y-2 rounded-md border border-border bg-muted/30 p-2">
                  <div className="grid grid-cols-2 gap-2">
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={editForm.check}
                        onChange={(e) =>
                          setEditForm({ ...editForm, check: e.target.checked })
                        }
                      />
                      Health check
                    </label>
                    <div>
                      <input
                        className={inputCls}
                        placeholder="interval ms (e.g. 2000)"
                        value={editForm.interval}
                        onChange={(e) =>
                          setEditForm({ ...editForm, interval: e.target.value })
                        }
                        aria-label="check interval"
                      />
                    </div>
                    <div>
                      <input
                        className={inputCls}
                        placeholder="fall (e.g. 3)"
                        value={editForm.fall}
                        onChange={(e) => setEditForm({ ...editForm, fall: e.target.value })}
                        aria-label="check fall"
                      />
                    </div>
                    <div>
                      <input
                        className={inputCls}
                        placeholder="rise (e.g. 2)"
                        value={editForm.rise}
                        onChange={(e) => setEditForm({ ...editForm, rise: e.target.value })}
                        aria-label="check rise"
                      />
                    </div>
                    <div>
                      <input
                        className={inputCls}
                        placeholder="weight"
                        value={editForm.weight}
                        onChange={(e) => setEditForm({ ...editForm, weight: e.target.value })}
                        aria-label="weight"
                      />
                    </div>
                  </div>
                  {editErr && <FieldError message={editErr} />}
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      disabled={editSaving}
                      onClick={() => saveServerCheck(s)}
                    >
                      {editSaving ? "Saving…" : "Save check params"}
                    </Button>
                  </div>
                </div>
              )}
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
