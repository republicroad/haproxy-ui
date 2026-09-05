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
import { dpGet, dpPost, dpDelete, dpPut, withTransaction } from "#/lib/dataplane/client"
import { LogTargetsPanel } from "./LogTargetsPanel"
import type { Frontend, Backend } from "#/lib/types"
import { aclInputSchema, mapEntryInputSchema, fieldErrors } from "#/lib/schemas"

type Acl = { acl_name: string; criterion: string; value?: string }
type MapEntry = { id: string; key: string; value: string }
type HttpRule = {
  type: string
  http_rule_condition?: { cond: string; val?: string }
  redirect_code?: number
  redirect_destination?: string
  deny_status?: number
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null
  return <p className="text-xs text-destructive">{msg}</p>
}

/** Configuration ACL lines attached to a frontend or backend section. */
export function AclsTab({
  nodeId,
  frontends,
  backends,
  onChanged,
}: {
  nodeId: string
  frontends: Frontend[]
  backends: Backend[]
  onChanged: () => void
}) {
  const qc = useQueryClient()
  const [parentType, setParentType] = useState<"frontends" | "backends">("frontends")
  const options = parentType === "frontends" ? frontends : backends
  const [parentName, setParentName] = useState<string>("")
  const effectiveName = parentName || options[0]?.name || ""
  const [form, setForm] = useState({ acl_name: "", criterion: "", value: "" })
  const [ruleForm, setRuleForm] = useState({
    type: "redirect" as "redirect" | "deny",
    redirectCode: "301",
    redirectDestination: "",
    denyStatus: "403",
    condVal: "",
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [pending, setPending] = useState(false)

  const key = `${parentType}|${effectiveName}`
  const aclsQ = useQuery({
    queryKey: ["acls", nodeId, key],
    queryFn: () =>
      dpGet<Acl[]>(
        nodeId,
        `services/haproxy/configuration/${parentType}/${encodeURIComponent(effectiveName)}/acls`,
      ),
    enabled: Boolean(effectiveName),
  })
  const acls = aclsQ.data ?? []

  const basePath = `services/haproxy/configuration/${parentType}/${encodeURIComponent(effectiveName)}/acls`
  const rulesPath = `services/haproxy/configuration/${parentType}/${encodeURIComponent(effectiveName)}/http_request_rules`

  const rulesQ = useQuery({
    queryKey: ["rules", nodeId, key],
    queryFn: () => dpGet<HttpRule[]>(nodeId, rulesPath),
    enabled: Boolean(effectiveName),
  })
  const rules = rulesQ.data ?? []

  const reload = () => {
    qc.invalidateQueries({ queryKey: ["acls", nodeId, key] })
    qc.invalidateQueries({ queryKey: ["rules", nodeId, key] })
    onChanged()
  }

  const addAcl = async () => {
    const parsed = aclInputSchema.safeParse({
      acl_name: form.acl_name,
      criterion: form.criterion,
      value: form.value || undefined,
    })
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error))
      return
    }
    setErrors({})
    setPending(true)
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await dpPost(
            nodeId,
            `${basePath}/${acls.length}`,
            parsed.data,
            tx,
          )
        },
        {
          kind: "create",
          resource: "acl",
          target: parsed.data.acl_name,
          parent: `${parentType.replace(/s$/, "")}/${effectiveName}`,
          payload: parsed.data,
        },
      )
      toast.success(`ACL "${form.acl_name}" added to ${effectiveName}`)
      setForm({ acl_name: "", criterion: "", value: "" })
      reload()
    } catch (e) {
      toast.error("Failed to add ACL", { description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  const addRule = async () => {
    const body: HttpRule = { type: ruleForm.type }
    if (ruleForm.condVal.trim()) {
      body.http_rule_condition = { cond: "if", val: ruleForm.condVal.trim() }
    }
    if (ruleForm.type === "redirect") {
      const code = Number(ruleForm.redirectCode)
      if (![301, 302, 307, 308].includes(code)) {
        setErrors({ redirect_code: "code must be 301/302/307/308" })
        return
      }
      if (!ruleForm.redirectDestination.trim()) {
        setErrors({ redirect_destination: "destination is required" })
        return
      }
      body.redirect_code = code
      body.redirect_destination = ruleForm.redirectDestination.trim()
    } else {
      const status = Number(ruleForm.denyStatus)
      if (![403, 404].includes(status)) {
        setErrors({ deny_status: "status must be 403 or 404" })
        return
      }
      body.deny_status = status
    }
    setErrors({})
    setPending(true)
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await dpPost(nodeId, `${rulesPath}/${rules.length}`, body, tx)
        },
        {
          kind: "create",
          resource: "rule",
          target: `${ruleForm.type}${ruleForm.redirectDestination ? `→${ruleForm.redirectDestination}` : ""}`,
          parent: `${parentType.replace(/s$/, "")}/${effectiveName}`,
          payload: body,
        },
      )
      toast.success("Request rule added")
      reload()
    } catch (e) {
      toast.error("Failed to add rule", { description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  const removeRule = async (rule: HttpRule, index: number) => {
    setPending(true)
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await dpDelete(nodeId, `${rulesPath}/${index}`, tx)
        },
        {
          kind: "delete",
          resource: "rule",
          target: rule.type,
          parent: `${parentType.replace(/s$/, "")}/${effectiveName}`,
          payload: rule,
        },
      )
      toast.success("Request rule removed")
      reload()
    } catch (e) {
      toast.error("Failed to remove rule", { description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  const removeAcl = async (acl: Acl, index: number) => {
    setPending(true)
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await dpDelete(nodeId, `${basePath}/${index}`, tx)
        },
        {
          kind: "delete",
          resource: "acl",
          target: acl.acl_name,
          parent: `${parentType.replace(/s$/, "")}/${effectiveName}`,
          payload: acl,
        },
      )
      toast.success(`ACL "${acl.acl_name}" removed`)
      reload()
    } catch (e) {
      toast.error("Failed to remove ACL", { description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Section</Label>
          <Select
            value={parentType}
            onValueChange={(v) => {
              setParentType(v as "frontends" | "backends")
              setParentName("")
            }}
          >
            <SelectTrigger className="w-[130px]" aria-label="ACL section type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="frontends">Frontend</SelectItem>
              <SelectItem value="backends">Backend</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Name</Label>
          <Select value={effectiveName} onValueChange={(v) => setParentName(v ?? "")}>
            <SelectTrigger className="w-[200px]" aria-label="section name">
              <SelectValue placeholder={options.length ? "pick one" : "none"} />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.name} value={o.name}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {!effectiveName ? (
        <p className="text-sm text-muted-foreground">
          Create a frontend or backend first.
        </p>
      ) : aclsQ.isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Criterion</th>
                <th className="px-3 py-2">Value</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {acls.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-3 text-muted-foreground">
                    No ACL lines on this section.
                  </td>
                </tr>
              )}
              {acls.map((a, i) => (
                <tr key={`${a.acl_name}-${i}`} className="border-t border-border">
                  <td className="px-3 py-2 text-muted-foreground">{i}</td>
                  <td className="px-3 py-2 font-medium">{a.acl_name}</td>
                  <td className="px-3 py-2">{a.criterion}</td>
                  <td className="px-3 py-2">{a.value || "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      size="xs"
                      variant="destructive"
                      disabled={pending}
                      onClick={() => removeAcl(a, i)}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded-lg border border-border p-3">
        <div className="mb-2 text-sm font-medium">Add ACL line</div>
        <div className="flex flex-wrap items-start gap-2">
          <div>
            <Input
              placeholder="acl_name (e.g. is_admin)"
              value={form.acl_name}
              onChange={(e) => setForm({ ...form, acl_name: e.target.value })}
              className="w-44"
              aria-label="acl name"
            />
            <FieldError msg={errors.acl_name} />
          </div>
          <div>
            <Input
              placeholder="criterion (e.g. path_beg)"
              value={form.criterion}
              onChange={(e) => setForm({ ...form, criterion: e.target.value })}
              className="w-44"
              aria-label="criterion"
            />
            <FieldError msg={errors.criterion} />
          </div>
          <div>
            <Input
              placeholder="value (e.g. /admin)"
              value={form.value}
              onChange={(e) => setForm({ ...form, value: e.target.value })}
              className="w-44"
              aria-label="value"
            />
            <FieldError msg={errors.value} />
          </div>
          <Button onClick={addAcl} disabled={pending || !effectiveName}>
            {pending ? "Working…" : "Add"}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Applied in a validated transaction; recorded in history.
        </p>
      </div>

      {/* ---- HTTP request rules ---- */}
      <div className="mb-1 mt-2 text-sm font-semibold">HTTP request rules</div>
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Params</th>
              <th className="px-3 py-2">Condition</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-3 text-muted-foreground">
                  No HTTP request rules on this section.
                </td>
              </tr>
            )}
            {rules.map((r, i) => (
              <tr key={`${r.type}-${i}`} className="border-t border-border">
                <td className="px-3 py-2 text-muted-foreground">{i}</td>
                <td className="px-3 py-2 font-medium">{r.type}</td>
                <td className="px-3 py-2">
                  {r.type === "redirect" &&
                    `${r.redirect_code ?? 302} → ${r.redirect_destination ?? "?"}`}
                  {r.type === "deny" && `status ${r.deny_status ?? 403}`}
                  {!["redirect", "deny"].includes(r.type) && r.type}
                </td>
                <td className="px-3 py-2">
                  {r.http_rule_condition
                    ? `${r.http_rule_condition.cond} ${r.http_rule_condition.val ?? ""}`
                    : "always"}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    size="xs"
                    variant="destructive"
                    disabled={pending}
                    onClick={() => removeRule(r, i)}
                  >
                    Delete
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="mb-2 text-sm font-medium">Add request rule</div>
        <div className="flex flex-wrap items-start gap-2">
          <div>
            <Select value={ruleForm.type} onValueChange={(v) => setRuleForm({ ...ruleForm, type: (v ?? "redirect") as "redirect" | "deny" })}>
              <SelectTrigger className="w-[130px]" aria-label="rule type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="redirect">redirect</SelectItem>
                <SelectItem value="deny">deny</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {ruleForm.type === "redirect" && (
            <>
              <div>
                <Input
                  placeholder="code (301/302/307/308)"
                  value={ruleForm.redirectCode}
                  onChange={(e) => setRuleForm({ ...ruleForm, redirectCode: e.target.value })}
                  className="w-44"
                  aria-label="redirect code"
                />
                <FieldError msg={errors.redirect_code} />
              </div>
              <div>
                <Input
                  placeholder="destination (e.g. /new)"
                  value={ruleForm.redirectDestination}
                  onChange={(e) => setRuleForm({ ...ruleForm, redirectDestination: e.target.value })}
                  className="w-48"
                  aria-label="redirect destination"
                />
                <FieldError msg={errors.redirect_destination} />
              </div>
            </>
          )}
          {ruleForm.type === "deny" && (
            <div>
              <Input
                placeholder="status (403/404)"
                value={ruleForm.denyStatus}
                onChange={(e) => setRuleForm({ ...ruleForm, denyStatus: e.target.value })}
                className="w-32"
                aria-label="deny status"
              />
              <FieldError msg={errors.deny_status} />
            </div>
          )}
          <div>
            <Input
              placeholder="condition val (optional, e.g. path_beg /old)"
              value={ruleForm.condVal}
              onChange={(e) => setRuleForm({ ...ruleForm, condVal: e.target.value })}
              className="w-56"
              aria-label="condition value"
            />
          </div>
          <Button onClick={addRule} disabled={pending || !effectiveName}>
            {pending ? "Working…" : "Add rule"}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Rules evaluate top-down; new rules append last. Transactional +
          recorded in history.
        </p>
      </div>

      <LogTargetsPanel nodeId={nodeId} parentType={parentType} parentName={effectiveName} />
    </div>
  )
}

/** Runtime map files and their key/value entries (live, no reload). */
export function MapsTab({ nodeId }: { nodeId: string }) {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string>("")
  const [form, setForm] = useState({ key: "", value: "" })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [pending, setPending] = useState(false)

  const mapsQ = useQuery({
    queryKey: ["runtime-maps", nodeId],
    queryFn: () =>
      dpGet<{ id: string; storage_name?: string; description?: string }[]>(
        nodeId,
        "services/haproxy/runtime/maps",
      ),
  })
  const maps = mapsQ.data ?? []
  const effectiveMap = selected || maps[0]?.id || ""

  const entriesQ = useQuery({
    queryKey: ["runtime-map-entries", nodeId, effectiveMap],
    queryFn: () =>
      dpGet<MapEntry[]>(
        nodeId,
        `services/haproxy/runtime/maps/${encodeURIComponent(effectiveMap)}/entries`,
      ),
    enabled: Boolean(effectiveMap),
  })
  const entries = entriesQ.data ?? []

  const reload = () => {
    qc.invalidateQueries({ queryKey: ["runtime-map-entries", nodeId, effectiveMap] })
    qc.invalidateQueries({ queryKey: ["runtime-maps", nodeId] })
  }

  const addEntry = async () => {
    const parsed = mapEntryInputSchema.safeParse(form)
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error))
      return
    }
    setErrors({})
    setPending(true)
    try {
      await dpPost(
        nodeId,
        `services/haproxy/runtime/maps/${encodeURIComponent(effectiveMap)}/entries`,
        parsed.data,
      )
      toast.success(`Entry "${form.key}" added`)
      setForm({ key: "", value: "" })
      reload()
    } catch (e) {
      toast.error("Failed to add entry", { description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  const updateValue = async (entry: MapEntry, value: string) => {
    setPending(true)
    try {
      await dpPut(
        nodeId,
        `services/haproxy/runtime/maps/${encodeURIComponent(effectiveMap)}/entries/${encodeURIComponent(entry.id)}`,
        { key: entry.key, value },
      )
      toast.success(`Entry "${entry.key}" updated`)
      reload()
    } catch (e) {
      toast.error("Failed to update entry", { description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  const removeEntry = async (entry: MapEntry) => {
    setPending(true)
    try {
      await dpDelete(
        nodeId,
        `services/haproxy/runtime/maps/${encodeURIComponent(effectiveMap)}/entries/${encodeURIComponent(entry.id)}`,
      )
      toast.success(`Entry "${entry.key}" removed`)
      reload()
    } catch (e) {
      toast.error("Failed to remove entry", { description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Map file</Label>
          <Select value={effectiveMap} onValueChange={(v) => setSelected(v ?? "")}>
            <SelectTrigger className="w-[260px]" aria-label="map file">
              <SelectValue placeholder={maps.length ? "pick one" : "none"} />
            </SelectTrigger>
            <SelectContent>
              {maps.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.storage_name ?? m.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {maps.length === 0 && !mapsQ.isLoading && (
          <p className="text-sm text-muted-foreground">
            No runtime maps loaded on this node.
          </p>
        )}
      </div>

      {effectiveMap && (
        <>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Key</th>
                  <th className="px-3 py-2">Value</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {entries.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-3 text-muted-foreground">
                      No entries in this map.
                    </td>
                  </tr>
                )}
                {entries.map((e) => (
                  <tr key={e.id} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">{e.key}</td>
                    <td className="px-3 py-2">
                      <Input
                        defaultValue={e.value}
                        onBlur={(ev) => {
                          if (ev.target.value !== e.value) updateValue(e, ev.target.value)
                        }}
                        className="h-7 w-56 font-mono text-xs"
                        aria-label={`value for ${e.key}`}
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="xs"
                        variant="destructive"
                        disabled={pending}
                        onClick={() => removeEntry(e)}
                      >
                        Delete
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-lg border border-border p-3">
            <div className="mb-2 text-sm font-medium">Add entry</div>
            <div className="flex flex-wrap items-start gap-2">
              <div>
                <Input
                  placeholder="key"
                  value={form.key}
                  onChange={(e) => setForm({ ...form, key: e.target.value })}
                  className="w-44 font-mono text-xs"
                  aria-label="map key"
                />
                <FieldError msg={errors.key} />
              </div>
              <div>
                <Input
                  placeholder="value"
                  value={form.value}
                  onChange={(e) => setForm({ ...form, value: e.target.value })}
                  className="w-44 font-mono text-xs"
                  aria-label="map value"
                />
                <FieldError msg={errors.value} />
              </div>
              <Button onClick={addEntry} disabled={pending}>
                {pending ? "Working…" : "Add"}
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Runtime entries apply immediately (no reload).
            </p>
          </div>
        </>
      )}
    </div>
  )
}
