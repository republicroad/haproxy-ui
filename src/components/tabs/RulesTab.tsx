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
import { dpGet, dpPost, dpPut, dpDelete, withTransaction, type ChangeMeta } from "#/lib/dataplane/client"
import type { Frontend, Backend } from "#/lib/types"
import {
  fieldErrors,
  rateLimitInputSchema,
  switchingRuleInputSchema,
  healthCheckInputSchema,
} from "#/lib/schemas"

type RuleCond = { cond: string; val?: string }

type HttpRequestRule = {
  type: string
  http_rule_condition?: RuleCond
  redirect_code?: number
  redirect_destination?: string
  deny_status?: number
  hdr_name?: string
  hdr_format?: string
}

type TcpRule = {
  type: string
  http_rule_condition?: RuleCond
}

type SwitchRule = {
  name: string
  cond: string
  cond_test?: string
}

type HttpCheck = {
  type: "status" | "string" | "rlen"
  value?: string
}

type ParentType = "frontends" | "backends"

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null
  return <p className="text-xs text-destructive">{msg}</p>
}

function SectionPicker({
  parentType,
  setParentType,
  options,
  effectiveName,
  setParentName,
  testIdPrefix,
}: {
  parentType: ParentType
  setParentType: (v: ParentType) => void
  options: { name: string }[]
  effectiveName: string
  setParentName: (v: string) => void
  testIdPrefix: string
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <Label className="mb-1 block text-xs text-muted-foreground">Section</Label>
        <Select
          value={parentType}
          onValueChange={(v) => {
            setParentType(v as ParentType)
            setParentName("")
          }}
        >
          <SelectTrigger className="w-[130px]" aria-label={`${testIdPrefix} section type`}>
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
          <SelectTrigger className="w-[200px]" aria-label={`${testIdPrefix} section name`}>
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
  )
}

/** Shared table for indexed rule collections with per-row delete. */
function RulesTable({
  rows,
  pending,
  emptyText,
  columns,
  onDelete,
}: {
  rows: Record<string, unknown>[]
  pending: boolean
  emptyText: string
  columns: string[]
  onDelete: (row: Record<string, unknown>, index: number) => void
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2">#</th>
            {columns.map((c) => (
              <th key={c} className="px-3 py-2">
                {c}
              </th>
            ))}
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length + 2} className="px-3 py-3 text-muted-foreground">
                {emptyText}
              </td>
            </tr>
          )}
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border">
              <td className="px-3 py-2 text-muted-foreground">{i}</td>
              {columns.map((c, ci) => (
                <td key={c} className="px-3 py-2">
                  {ci === 0 ? (
                    <span className="font-medium">{String(r[c])}</span>
                  ) : (
                    String(r[c])
                  )}
                </td>
              ))}
              <td className="px-3 py-2 text-right">
                <Button
                  size="xs"
                  variant="destructive"
                  disabled={pending}
                  onClick={() => onDelete(r, i)}
                >
                  Delete
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function condText(c?: RuleCond): string {
  return c ? `${c.cond} ${c.val ?? ""}` : "always"
}

function httpRuleParams(r: HttpRequestRule): string {
  switch (r.type) {
    case "redirect":
      return `${r.redirect_code ?? 302} → ${r.redirect_destination ?? "?"}`
    case "deny":
      return `status ${r.deny_status ?? 403}`
    case "del-header":
      return r.hdr_name ?? "?"
    case "set-header":
    case "add-header":
      return `${r.hdr_name ?? "?"}: ${r.hdr_format ?? ""}`
    default:
      return ""
  }
}

/** Condition input shared by all rule forms. */
function ConditionInput({
  value,
  onChange,
  required,
}: {
  value: string
  onChange: (v: string) => void
  required?: boolean
}) {
  return (
    <div>
      <Input
        placeholder={required ? "condition (e.g. path_beg /old)" : "condition val (optional)"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-56"
        aria-label="condition value"
      />
      {required && !value.trim() && (
        <FieldError msg="condition is required for TCP rules" />
      )}
    </div>
  )
}

/**
 * All traffic-rule families on one screen: HTTP request/response rules,
 * TCP request rules, use_backend switching rules, active health checks
 * and a rate-limit preset. Everything applies through validated
 * transactions and is recorded in the change history.
 */
export function RulesTab({
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
  const [parentType, setParentType] = useState<ParentType>("frontends")
  const options = parentType === "frontends" ? frontends : backends
  const [parentName, setParentName] = useState<string>("")
  const effectiveName = parentName || options[0]?.name || ""
  const [pending, setPending] = useState(false)

  const key = `${parentType}|${effectiveName}`
  const sub = (s: string) =>
    `services/haproxy/configuration/${parentType}/${encodeURIComponent(effectiveName)}/${s}`

  const useQueryList = <T,>(name: string, path: string) =>
    useQuery<T[]>({
      queryKey: ["rules", nodeId, key, name],
      queryFn: () => dpGet<T[]>(nodeId, path),
      enabled: Boolean(effectiveName),
    })

  const httpReqQ = useQueryList<HttpRequestRule>("http_request_rules", sub("http_request_rules"))
  const httpResQ = useQueryList<HttpRequestRule>("http_response_rules", sub("http_response_rules"))
  const tcpQ = useQueryList<TcpRule>("tcp_request_rules", sub("tcp_request_rules"))
  const switchQ = useQueryList<SwitchRule>("backend_switching_rules", sub("backend_switching_rules"))
  const checkQ = useQueryList<HttpCheck>("http_checks", sub("http_checks"))

  const reload = (name: string) => {
    qc.invalidateQueries({ queryKey: ["rules", nodeId, key, name] })
    onChanged()
  }

  const addIndexed = async (
    name: string,
    rows: unknown[] | undefined,
    body: unknown,
    meta: { resource: ChangeMeta["resource"]; target: string },
  ) => {
    setPending(true)
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await dpPost(nodeId, `${sub(name)}/${rows?.length ?? 0}`, body, tx)
        },
        {
          kind: "create",
          resource: meta.resource,
          target: meta.target,
          parent: `${parentType.replace(/s$/, "")}/${effectiveName}`,
          payload: body,
        },
      )
      toast.success("Rule added")
      reload(name)
    } catch (e) {
      toast.error("Failed to add rule", { description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  const deleteIndexed = async (
    name: string,
    index: number,
    meta: { resource: ChangeMeta["resource"]; target: string; payload: unknown },
  ) => {
    setPending(true)
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await dpDelete(nodeId, `${sub(name)}/${index}`, tx)
        },
        {
          kind: "delete",
          resource: meta.resource,
          target: meta.target,
          parent: `${parentType.replace(/s$/, "")}/${effectiveName}`,
          payload: meta.payload,
        },
      )
      toast.success("Rule removed")
      reload(name)
    } catch (e) {
      toast.error("Failed to remove rule", { description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  // ---------------- HTTP request + response rules ----------------

  const emptyHttpForm = {
    type: "redirect",
    redirectCode: "301",
    redirectDestination: "",
    denyStatus: "403",
    hdrName: "",
    hdrFormat: "",
    condVal: "",
  }
  const [reqForm, setReqForm] = useState(emptyHttpForm)
  const [reqErrors, setReqErrors] = useState<Record<string, string>>({})
  const [resForm, setResForm] = useState({ ...emptyHttpForm, type: "set-header" })
  const [resErrors, setResErrors] = useState<Record<string, string>>({})

  const buildHttpRule = (
    form: typeof reqForm,
    errors: Record<string, string>,
  ): HttpRequestRule | null => {
    const body: HttpRequestRule = { type: form.type }
    if (form.condVal.trim()) body.http_rule_condition = { cond: "if", val: form.condVal.trim() }
    if (form.type === "redirect") {
      const code = Number(form.redirectCode)
      if (![301, 302, 307, 308].includes(code)) {
        errors.redirect_code = "code must be 301/302/307/308"
        return null
      }
      if (!form.redirectDestination.trim()) {
        errors.redirect_destination = "destination is required"
        return null
      }
      body.redirect_code = code
      body.redirect_destination = form.redirectDestination.trim()
    } else if (form.type === "deny") {
      const status = Number(form.denyStatus)
      if (![403, 404].includes(status)) {
        errors.deny_status = "status must be 403 or 404"
        return null
      }
      body.deny_status = status
    } else {
      if (!form.hdrName.trim()) {
        errors.hdr_name = "header name is required"
        return null
      }
      body.hdr_name = form.hdrName.trim()
      if (form.type !== "del-header") {
        if (!form.hdrFormat.trim()) {
          errors.hdr_format = "header value is required"
          return null
        }
        body.hdr_format = form.hdrFormat.trim()
      }
    }
    return body
  }

  const httpRuleForm = (
    form: typeof reqForm,
    setForm: (f: typeof reqForm) => void,
    errors: Record<string, string>,
    setErrors: (e: Record<string, string>) => void,
    family: "http_request_rules" | "http_response_rules",
    types: string[],
  ) => (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 text-sm font-medium">Add rule</div>
      <div className="flex flex-wrap items-start gap-2">
        <div>
          <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v ?? types[0] })}>
            <SelectTrigger className="w-[130px]" aria-label="rule type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {types.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {form.type === "redirect" && (
          <>
            <div>
              <Input
                placeholder="code (301/302/307/308)"
                value={form.redirectCode}
                onChange={(e) => setForm({ ...form, redirectCode: e.target.value })}
                className="w-44"
                aria-label="redirect code"
              />
              <FieldError msg={errors.redirect_code} />
            </div>
            <div>
              <Input
                placeholder="destination (e.g. /new)"
                value={form.redirectDestination}
                onChange={(e) => setForm({ ...form, redirectDestination: e.target.value })}
                className="w-48"
                aria-label="redirect destination"
              />
              <FieldError msg={errors.redirect_destination} />
            </div>
          </>
        )}
        {form.type === "deny" && (
          <div>
            <Input
              placeholder="status (403/404)"
              value={form.denyStatus}
              onChange={(e) => setForm({ ...form, denyStatus: e.target.value })}
              className="w-32"
              aria-label="deny status"
            />
            <FieldError msg={errors.deny_status} />
          </div>
        )}
        {!["redirect", "deny"].includes(form.type) && (
          <>
            <div>
              <Input
                placeholder="header name (e.g. X-Forwarded-Proto)"
                value={form.hdrName}
                onChange={(e) => setForm({ ...form, hdrName: e.target.value })}
                className="w-56"
                aria-label="header name"
              />
              <FieldError msg={errors.hdr_name} />
            </div>
            {form.type !== "del-header" && (
              <div>
                <Input
                  placeholder="header value (e.g. https)"
                  value={form.hdrFormat}
                  onChange={(e) => setForm({ ...form, hdrFormat: e.target.value })}
                  className="w-48"
                  aria-label="header value"
                />
                <FieldError msg={errors.hdr_format} />
              </div>
            )}
          </>
        )}
        <ConditionInput
          value={form.condVal}
          onChange={(v) => setForm({ ...form, condVal: v })}
        />
        <Button
          onClick={() => {
            const errs: Record<string, string> = {}
            const body = buildHttpRule(form, errs)
            if (!body) {
              setErrors(errs)
              return
            }
            setErrors({})
            void addIndexed(family, family === "http_request_rules" ? httpReqQ.data : httpResQ.data, body, {
              resource: "rule",
              target: `${form.type}${form.type === "redirect" ? `→${form.redirectDestination}` : form.hdrName ? `:${form.hdrName}` : ""}`,
            })
          }}
          disabled={pending || !effectiveName}
        >
          {pending ? "Working…" : "Add rule"}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Rules evaluate top-down; new rules append last. Transactional + recorded
        in history.
      </p>
    </div>
  )

  const reqRows = (httpReqQ.data ?? []).map((r) => ({
    type: r.type,
    params: httpRuleParams(r),
    condition: condText(r.http_rule_condition),
  }))
  const resRows = (httpResQ.data ?? []).map((r) => ({
    type: r.type,
    params: httpRuleParams(r),
    condition: condText(r.http_rule_condition),
  }))
  const tcpRows = (tcpQ.data ?? []).map((r) => ({
    type: r.type,
    condition: condText(r.http_rule_condition),
  }))
  const switchRows = (switchQ.data ?? []).map((r) => ({
    backend: r.name,
    condition: `${r.cond} ${r.cond_test ?? ""}`,
  }))
  const checkRows = (checkQ.data ?? []).map((r) => {
    // real dataplaneapi stores expects as {type:"expect", value:"status 200"}
    const [kind, ...rest] = (r.value ?? "").split(" ")
    return {
      type: r.type === "expect" ? kind : r.type,
      value: r.type === "expect" ? rest.join(" ") : (r.value ?? ""),
    }
  })

  // ---------------- TCP rules form ----------------

  const [tcpForm, setTcpForm] = useState({ type: "accept", condVal: "" })
  const [tcpError, setTcpError] = useState<string | null>(null)

  // ---------------- switching rules form ----------------

  const [swForm, setSwForm] = useState({ backend: "", cond: "if", condTest: "" })
  const [swErrors, setSwErrors] = useState<Record<string, string>>({})

  // ---------------- health checks form ----------------

  const [chkForm, setChkForm] = useState({ type: "status", value: "200" })
  const [chkErrors, setChkErrors] = useState<Record<string, string>>({})

  // ---------------- rate limit preset ----------------

  const [rlForm, setRlForm] = useState({ maxRequests: "100", periodSeconds: "10", denyStatus: "429" })
  const [rlErrors, setRlErrors] = useState<Record<string, string>>({})
  const applyRateLimit = async () => {
    const parsed = rateLimitInputSchema.safeParse(rlForm)
    if (!parsed.success) {
      setRlErrors(fieldErrors(parsed.error))
      return
    }
    setRlErrors({})
    const { maxRequests, periodSeconds, denyStatus } = parsed.data
    const existing = httpReqQ.data ?? []
    setPending(true)
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await dpPut(
            nodeId,
            `services/haproxy/configuration/backends/${encodeURIComponent(effectiveName)}`,
            {
              stick_table: {
                type: "ip",
                size: "100k",
                expire: `${periodSeconds}s`,
                store: [`http_req_rate(${periodSeconds}s)`],
              },
            },
            tx,
          )
          await dpPost(
            nodeId,
            `${sub("http_request_rules")}/${existing.length}`,
            { type: "track-sc0", var_name: "src" },
            tx,
          )
          await dpPost(
            nodeId,
            `${sub("http_request_rules")}/${existing.length + 1}`,
            {
              type: "deny",
              deny_status: denyStatus,
              http_rule_condition: {
                cond: "if",
                val: `{ src http_req_rate(${periodSeconds}s) gt ${maxRequests} }`,
              },
            },
            tx,
          )
        },
        {
          kind: "create",
          resource: "ratelimit",
          target: `${maxRequests} req / ${periodSeconds}s → ${denyStatus}`,
          parent: `backend/${effectiveName}`,
          payload: parsed.data,
        },
      )
      toast.success(`Rate limit applied to ${effectiveName}`)
      reload("http_request_rules")
    } catch (e) {
      toast.error("Failed to apply rate limit", { description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-6">
      <SectionPicker
        parentType={parentType}
        setParentType={setParentType}
        options={options}
        effectiveName={effectiveName}
        setParentName={setParentName}
        testIdPrefix="rules"
      />

      {!effectiveName ? (
        <p className="text-sm text-muted-foreground">
          Create a frontend or backend first.
        </p>
      ) : (
        <>
          {/* HTTP request rules */}
          <section className="space-y-2">
            <div className="text-sm font-semibold">HTTP request rules</div>
            <RulesTable
              rows={reqRows}
              pending={pending}
              emptyText="No HTTP request rules on this section."
              columns={["type", "params", "condition"]}
              onDelete={(r, i) =>
                deleteIndexed("http_request_rules", i, {
                  resource: "rule",
                  target: String(r.type),
                  payload: (httpReqQ.data ?? [])[i],
                })
              }
            />
            {httpRuleForm(reqForm, setReqForm, reqErrors, setReqErrors, "http_request_rules", [
              "redirect",
              "deny",
              "set-header",
              "add-header",
              "del-header",
            ])}
          </section>

          {/* HTTP response rules */}
          <section className="space-y-2">
            <div className="text-sm font-semibold">HTTP response rules</div>
            <RulesTable
              rows={resRows}
              pending={pending}
              emptyText="No HTTP response rules on this section."
              columns={["type", "params", "condition"]}
              onDelete={(r, i) =>
                deleteIndexed("http_response_rules", i, {
                  resource: "rule",
                  target: String(r.type),
                  payload: (httpResQ.data ?? [])[i],
                })
              }
            />
            {httpRuleForm(resForm, setResForm, resErrors, setResErrors, "http_response_rules", [
              "set-header",
              "add-header",
              "del-header",
              "deny",
            ])}
          </section>

          {/* TCP request rules */}
          <section className="space-y-2">
            <div className="text-sm font-semibold">TCP request rules</div>
            <RulesTable
              rows={tcpRows}
              pending={pending}
              emptyText="No TCP request rules on this section."
              columns={["type", "condition"]}
              onDelete={(r, i) =>
                deleteIndexed("tcp_request_rules", i, {
                  resource: "rule",
                  target: String(r.type),
                  payload: (tcpQ.data ?? [])[i],
                })
              }
            />
            <div className="rounded-lg border border-border p-3">
              <div className="mb-2 text-sm font-medium">Add TCP rule</div>
              <div className="flex flex-wrap items-start gap-2">
                <div>
                  <Select
                    value={tcpForm.type}
                    onValueChange={(v) => setTcpForm({ ...tcpForm, type: v ?? "accept" })}
                  >
                    <SelectTrigger className="w-[130px]" aria-label="tcp rule type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="accept">accept</SelectItem>
                      <SelectItem value="reject">reject</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <ConditionInput
                  value={tcpForm.condVal}
                  onChange={(v) => setTcpForm({ ...tcpForm, condVal: v })}
                  required
                />
                <Button
                  onClick={() => {
                    if (!tcpForm.condVal.trim()) {
                      setTcpError("condition is required for TCP rules")
                      return
                    }
                    setTcpError(null)
                    void addIndexed(
                      "tcp_request_rules",
                      tcpQ.data,
                      {
                        type: tcpForm.type,
                        http_rule_condition: { cond: "if", val: tcpForm.condVal.trim() },
                      },
                      { resource: "rule", target: tcpForm.type },
                    )
                  }}
                  disabled={pending || !effectiveName}
                >
                  {pending ? "Working…" : "Add rule"}
                </Button>
              </div>
              <FieldError msg={tcpError ?? undefined} />
            </div>
          </section>

          {/* Backend switching rules (frontends only) */}
          {parentType === "frontends" && (
            <section className="space-y-2">
              <div className="text-sm font-semibold">Backend switching rules (use_backend)</div>
              <RulesTable
                rows={switchRows}
                pending={pending}
                emptyText="No switching rules — all traffic goes to the default backend."
                columns={["backend", "condition"]}
                onDelete={(r, i) =>
                  deleteIndexed("backend_switching_rules", i, {
                    resource: "switch",
                    target: String(r.backend),
                    payload: (switchQ.data ?? [])[i],
                  })
                }
              />
              <div className="rounded-lg border border-border p-3">
                <div className="mb-2 text-sm font-medium">Add switching rule</div>
                <div className="flex flex-wrap items-start gap-2">
                  <div>
                    <Select
                      value={swForm.backend}
                      onValueChange={(v) => setSwForm({ ...swForm, backend: v ?? "" })}
                    >
                      <SelectTrigger className="w-[200px]" aria-label="target backend">
                        <SelectValue placeholder={backends.length ? "target backend" : "no backends"} />
                      </SelectTrigger>
                      <SelectContent>
                        {backends.map((b) => (
                          <SelectItem key={b.name} value={b.name}>
                            {b.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Select
                      value={swForm.cond}
                      onValueChange={(v) => setSwForm({ ...swForm, cond: v ?? "if" })}
                    >
                      <SelectTrigger className="w-[110px]" aria-label="condition polarity">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="if">if</SelectItem>
                        <SelectItem value="unless">unless</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Input
                      placeholder="condition (e.g. { path_beg /api })"
                      value={swForm.condTest}
                      onChange={(e) => setSwForm({ ...swForm, condTest: e.target.value })}
                      className="w-64"
                      aria-label="switching condition"
                    />
                    <FieldError msg={swErrors.cond_test} />
                    <FieldError msg={swErrors.name} />
                  </div>
                  <Button
                    onClick={() => {
                      const parsed = switchingRuleInputSchema.safeParse({
                        name: swForm.backend,
                        cond: swForm.cond,
                        cond_test: swForm.condTest,
                      })
                      if (!parsed.success) {
                        setSwErrors(fieldErrors(parsed.error))
                        return
                      }
                      setSwErrors({})
                      void addIndexed("backend_switching_rules", switchQ.data, parsed.data, {
                        resource: "switch",
                        target: parsed.data.name,
                      })
                    }}
                    disabled={pending || !effectiveName || backends.length === 0}
                  >
                    {pending ? "Working…" : "Add rule"}
                  </Button>
                </div>
              </div>
            </section>
          )}

          {/* Active health checks (backends only) */}
          {parentType === "backends" && (
            <section className="space-y-2">
              <div className="text-sm font-semibold">Active health check expectations</div>
              <RulesTable
                rows={checkRows}
                pending={pending}
                emptyText="No http-check expectations — servers only get a TCP connect check."
                columns={["type", "value"]}
                onDelete={(r, i) =>
                  deleteIndexed("http_checks", i, {
                    resource: "check",
                    target: `${r.type} ${r.value ?? ""}`.trim(),
                    payload: (checkQ.data ?? [])[i],
                  })
                }
              />
              <div className="rounded-lg border border-border p-3">
                <div className="mb-2 text-sm font-medium">Add http-check expect</div>
                <div className="flex flex-wrap items-start gap-2">
                  <div>
                    <Select
                      value={chkForm.type}
                      onValueChange={(v) =>
                        setChkForm({ type: v ?? "status", value: v === "status" ? "200" : v === "rlen" ? "0" : "OK" })
                      }
                    >
                      <SelectTrigger className="w-[130px]" aria-label="check type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="status">status</SelectItem>
                        <SelectItem value="string">string</SelectItem>
                        <SelectItem value="rlen">rlen</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Input
                      placeholder={chkForm.type === "status" ? "status (e.g. 200)" : chkForm.type === "rlen" ? "max length" : "body substring"}
                      value={chkForm.value}
                      onChange={(e) => setChkForm({ ...chkForm, value: e.target.value })}
                      className="w-52"
                      aria-label="check value"
                    />
                    <FieldError msg={chkErrors.value} />
                    <FieldError msg={chkErrors.type} />
                  </div>
                  <Button
                    onClick={() => {
                      const parsed = healthCheckInputSchema.safeParse(chkForm)
                      if (!parsed.success) {
                        setChkErrors(fieldErrors(parsed.error))
                        return
                      }
                      setChkErrors({})
                      // dataplaneapi models an expectation as {type:"expect", value:"<kind> <value>"}
                      void addIndexed(
                        "http_checks",
                        checkQ.data,
                        { type: "expect", value: `${parsed.data.type} ${parsed.data.value}` },
                        {
                          resource: "check",
                          target: `${parsed.data.type} ${parsed.data.value}`,
                        },
                      )
                    }}
                    disabled={pending || !effectiveName}
                  >
                    {pending ? "Working…" : "Add check"}
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Applies to every server in this backend with checks enabled
                  (Servers dialog). Requires an HTTP-mode backend.
                </p>
              </div>
            </section>
          )}

          {/* Rate limit preset (backends only) */}
          {parentType === "backends" && (
            <section className="space-y-2">
              <div className="text-sm font-semibold">Rate limit preset</div>
              <div className="rounded-lg border border-border p-3">
                <div className="mb-2 text-sm font-medium">
                  Apply per-client-IP rate limit to this backend
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  <div>
                    <Input
                      placeholder="max requests"
                      value={rlForm.maxRequests}
                      onChange={(e) => setRlForm({ ...rlForm, maxRequests: e.target.value })}
                      className="w-40"
                      aria-label="max requests"
                    />
                    <FieldError msg={rlErrors.maxRequests} />
                  </div>
                  <div>
                    <Input
                      placeholder="window seconds"
                      value={rlForm.periodSeconds}
                      onChange={(e) => setRlForm({ ...rlForm, periodSeconds: e.target.value })}
                      className="w-40"
                      aria-label="window seconds"
                    />
                    <FieldError msg={rlErrors.periodSeconds} />
                  </div>
                  <div>
                    <Input
                      placeholder="deny status"
                      value={rlForm.denyStatus}
                      onChange={(e) => setRlForm({ ...rlForm, denyStatus: e.target.value })}
                      className="w-40"
                      aria-label="deny status"
                    />
                    <FieldError msg={rlErrors.denyStatus} />
                  </div>
                  <Button
                    onClick={() => void applyRateLimit()}
                    disabled={pending || !effectiveName}
                  >
                    {pending ? "Working…" : "Apply rate limit"}
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  One transaction adds a stick-table to the backend, a
                  track-sc0 rule and a deny rule for clients exceeding the
                  rate. Track/deny rules appear in the request-rules table.
                </p>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
