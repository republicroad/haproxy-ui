"use client"

import { useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Badge } from "#/components/reui/badge"
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
import type { Frontend, Backend } from "#/lib/types"
import {
  BOT_ALLOW_ACL,
  BOT_BLOCK_ACL,
  BOT_DETECT_ACL,
  BOT_DETECT_LINE,
  DEFAULT_BLOCKED_BOTS,
  DEFAULT_VERIFIED_BOTS,
  CUSTOM_ACL_PREFIX,
  IP_ALLOW_ACL,
  IP_DENY_ACL,
  WAF_PRESETS,
  aclIndicesByName,
  aclNameForPreset,
  aclValueForSignature,
  condBotBlock,
  condBotUnknown,
  condForPreset,
  condIpAllowOnly,
  condIpDeny,
  cidrAclLine,
  findDenyIndex,
  parseCidrList,
  signatureFromAclValue,
  type AclLine,
  type HttpRuleLike,
} from "#/lib/waf"
import { corazaAgentSnippet, haproxyFilterSnippet, spoeConfigSnippet } from "#/lib/spoe"

type ParentType = "frontends" | "backends"

/**
 * WAF & bot management, compiled to plain HAProxy configuration: every
 * toggle below is a named-ACL bundle plus an http-request deny rule,
 * applied transactionally (so `haproxy -c` gates every change) and
 * recorded in the change history.
 */
export function WafBotsTab({
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
  const [newSig, setNewSig] = useState("")
  const [newVerified, setNewVerified] = useState("")
  const [custom, setCustom] = useState({ name: "", criterion: "path_reg", value: "" })
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({})

  const key = `${parentType}|${effectiveName}`
  const basePath = `services/haproxy/configuration/${parentType}/${encodeURIComponent(effectiveName)}`

  const aclsQ = useQuery({
    queryKey: ["waf-acls", nodeId, key],
    queryFn: () => dpGet<AclLine[]>(nodeId, `${basePath}/acls`),
    enabled: Boolean(effectiveName),
  })
  const rulesQ = useQuery({
    queryKey: ["waf-rules", nodeId, key],
    queryFn: () => dpGet<HttpRuleLike[]>(nodeId, `${basePath}/http_request_rules`),
    enabled: Boolean(effectiveName),
  })
  const acls = aclsQ.data ?? []
  const rules = rulesQ.data ?? []

  const reload = () => {
    qc.invalidateQueries({ queryKey: ["waf-acls", nodeId, key] })
    qc.invalidateQueries({ queryKey: ["waf-rules", nodeId, key] })
    onChanged()
  }

  const activeAclCount = (aclName: string) => aclIndicesByName(acls, aclName).length

  const addAclLines = async (tx: string, lines: AclLine[]): Promise<void> => {
    let at = acls.length
    for (const line of lines) {
      await dpPost(nodeId, `${basePath}/acls/${at}`, line, tx)
      at++
    }
  }

  const removeAclLines = async (tx: string, aclName: string): Promise<void> => {
    const indices = aclIndicesByName(acls, aclName)
    for (const i of indices.reverse()) {
      await dpDelete(nodeId, `${basePath}/acls/${i}`, tx)
    }
  }

  const addDenyRule = async (tx: string, cond: string): Promise<void> => {
    await dpPost(
      nodeId,
      `${basePath}/http_request_rules/${rules.length}`,
      { type: "deny", http_rule_condition: { cond: "if", val: cond } },
      tx,
    )
  }

  const removeDenyRule = async (tx: string, token: string): Promise<void> => {
    const idx = findDenyIndex(rules, token)
    if (idx >= 0) {
      await dpDelete(nodeId, `${basePath}/http_request_rules/${idx}`, tx)
    }
  }

  const toggleBundle = async (
    enable: boolean,
    aclNames: string[],
    cond: string,
    seedAcls?: AclLine[],
    label = cond,
    lookup = cond.split(/\s+/)[0].replace(/^!/, ""),
  ) => {
    setPending(true)
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          if (enable) {
            for (const name of aclNames) {
              if (activeAclCount(name) === 0 && seedAcls) {
                const lines = seedAcls.filter((l) => l.acl_name === name)
                if (lines.length > 0) await addAclLines(tx, lines)
              }
            }
            if (findDenyIndex(rules, lookup) < 0) {
              await addDenyRule(tx, cond)
            }
          } else {
            await removeDenyRule(tx, lookup)
          }
        },
        {
          kind: enable ? "create" : "delete",
          resource: "rule",
          target: label,
          parent: `${parentType.replace(/s$/, "")}/${effectiveName}`,
          payload: { enable, cond, aclNames },
        },
      )
      toast.success(`${label} ${enable ? "enabled" : "disabled"}`)
      reload()
    } catch (e) {
      toast.error(`Failed to ${enable ? "enable" : "disable"} ${label}`, {
        description: (e as Error).message,
      })
    } finally {
      setPending(false)
    }
  }

  /** Replace the whole CIDR list held by an ACL bundle in one transaction. */
  const saveCidrList = async (aclName: string, raw: string, label: string) => {
    const { valid, invalid } = parseCidrList(raw)
    if (invalid.length > 0) {
      toast.error(`Invalid entries ignored: ${invalid.slice(0, 5).join(", ")}`)
    }
    if (valid.length === 0) {
      toast.error("Nothing to save — provide at least one CIDR or hostname")
      return
    }
    setPending(true)
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await removeAclLines(tx, aclName)
          await addAclLines(tx, [cidrAclLine(aclName, valid)])
        },
        {
          kind: "update",
          resource: "acl",
          target: `${label} (${valid.length} entries)`,
          parent: `${parentType.replace(/s$/, "")}/${effectiveName}`,
          payload: { aclName, cidrs: valid },
        },
      )
      toast.success(`${label} saved (${valid.length} entries)`)
      reload()
    } catch (e) {
      toast.error(`Failed to save ${label}`, { description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  const addSignature = async (aclName: string, signature: string, reset: () => void) => {
    const sig = signature.trim()
    if (!sig) return
    setPending(true)
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await addAclLines(tx, [
            { acl_name: aclName, criterion: "req.hdr(user-agent)", value: aclValueForSignature(sig) },
          ])
        },
        {
          kind: "create",
          resource: "acl",
          target: sig,
          parent: `${parentType.replace(/s$/, "")}/${effectiveName}`,
          payload: { aclName, signature: sig },
        },
      )
      toast.success(`Signature "${sig}" added`)
      reset()
      reload()
    } catch (e) {
      toast.error("Failed to add signature", { description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  const removeSignature = async (aclName: string, index: number, signature: string) => {
    setPending(true)
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await dpDelete(nodeId, `${basePath}/acls/${index}`, tx)
        },
        {
          kind: "delete",
          resource: "acl",
          target: signature,
          parent: `${parentType.replace(/s$/, "")}/${effectiveName}`,
          payload: { aclName, index },
        },
      )
      toast.success(`Signature "${signature}" removed`)
      reload()
    } catch (e) {
      toast.error("Failed to remove signature", { description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  const addCustomRule = async () => {
    const name = custom.name.trim()
    const value = custom.value.trim()
    const errs: Record<string, string> = {}
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(name)) errs.name = "letters, digits, _ . - only"
    if (!custom.criterion.trim()) errs.criterion = "criterion is required"
    if (!value) errs.value = "value is required"
    if (Object.keys(errs).length > 0) {
      setCustomErrors(errs)
      return
    }
    setCustomErrors({})
    const aclName = `${CUSTOM_ACL_PREFIX}${name}`
    setPending(true)
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await addAclLines(tx, [
            { acl_name: aclName, criterion: custom.criterion.trim(), value },
          ])
          await addDenyRule(tx, aclName)
        },
        {
          kind: "create",
          resource: "acl",
          target: `${name}: ${value}`,
          parent: `${parentType.replace(/s$/, "")}/${effectiveName}`,
          payload: { aclName, criterion: custom.criterion, value },
        },
      )
      toast.success(`Custom rule "${name}" added`)
      setCustom({ name: "", criterion: "path_reg", value: "" })
      reload()
    } catch (e) {
      toast.error("Failed to add custom rule", { description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  const removeCustomRule = async (aclName: string) => {
    setPending(true)
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await removeDenyRule(tx, aclName)
          await removeAclLines(tx, aclName)
        },
        {
          kind: "delete",
          resource: "acl",
          target: aclName,
          parent: `${parentType.replace(/s$/, "")}/${effectiveName}`,
          payload: { aclName },
        },
      )
      toast.success(`Custom rule "${aclName}" removed`)
      reload()
    } catch (e) {
      toast.error("Failed to remove custom rule", { description: (e as Error).message })
    } finally {
      setPending(false)
    }
  }

  const customAcls = acls.filter((a) => a.acl_name.startsWith(CUSTOM_ACL_PREFIX))
  const customNames = [...new Set(customAcls.map((a) => a.acl_name))]
  const blockedSigs = acls
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.acl_name === BOT_BLOCK_ACL)
    .map(({ a, i }) => ({ index: i, signature: signatureFromAclValue(a.value) }))
  const verifiedSigs = acls
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.acl_name === BOT_ALLOW_ACL)
    .map(({ a, i }) => ({ index: i, signature: signatureFromAclValue(a.value) }))

  if (!effectiveName) {
    return (
      <div className="space-y-3">
        <SectionPicker
          parentType={parentType}
          setParentType={setParentType}
          options={options}
          effectiveName={effectiveName}
          setParentName={setParentName}
        />
        <p className="text-sm text-muted-foreground">Create a frontend or backend first.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <SectionPicker
        parentType={parentType}
        setParentType={setParentType}
        options={options}
        effectiveName={effectiveName}
        setParentName={setParentName}
      />

      {/* WAF presets */}
      <section className="space-y-2">
        <div className="text-sm font-semibold">WAF protection</div>
        <p className="text-xs text-muted-foreground">
          Each preset is a bundle of named ACLs plus one deny rule on this
          section — plain HAProxy config, validated by <code>haproxy -c</code>{" "}
          on every change.
        </p>
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Preset</th>
                <th className="px-3 py-2">What it blocks</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {WAF_PRESETS.map((p) => {
                const active = findDenyIndex(rules, condForPreset(p.id)) >= 0
                return (
                  <tr key={p.id} className="border-t border-border">
                    <td className="px-3 py-2 font-medium">{p.label}</td>
                    <td className="px-3 py-2 text-muted-foreground">{p.description}</td>
                    <td className="px-3 py-2">
                      <Badge variant={active ? "success" : "secondary"}>
                        {active ? "active" : "off"}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="xs"
                        variant={active ? "destructive" : "default"}
                        disabled={pending}
                        onClick={() =>
                          void toggleBundle(
                            !active,
                            [aclNameForPreset(p.id)],
                            condForPreset(p.id),
                            p.acls,
                            p.label,
                          )
                        }
                      >
                        {active ? "Disable" : "Enable"}
                      </Button>
                    </td>
                  </tr>
                )
              })}
              {customNames.map((aclName) => {
                const active = findDenyIndex(rules, aclName) >= 0
                const line = customAcls.find((a) => a.acl_name === aclName)
                return (
                  <tr key={aclName} className="border-t border-border">
                    <td className="px-3 py-2 font-medium">
                      Custom: {aclName.slice(CUSTOM_ACL_PREFIX.length)}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                      {line?.criterion} {line?.value}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={active ? "success" : "secondary"}>
                        {active ? "active" : "off"}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="xs"
                        variant="destructive"
                        disabled={pending}
                        onClick={() => void removeCustomRule(aclName)}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* custom rule form */}
        <div className="rounded-lg border border-border p-3">
          <div className="mb-2 text-sm font-medium">Add custom WAF rule</div>
          <div className="flex flex-wrap items-start gap-2">
            <div>
              <Input
                placeholder="rule name"
                value={custom.name}
                onChange={(e) => setCustom({ ...custom, name: e.target.value })}
                className="w-40"
                aria-label="custom rule name"
              />
              {customErrors.name && (
                <p className="text-xs text-destructive">{customErrors.name}</p>
              )}
            </div>
            <div>
              <Input
                placeholder="criterion (e.g. path_reg)"
                value={custom.criterion}
                onChange={(e) => setCustom({ ...custom, criterion: e.target.value })}
                className="w-44"
                aria-label="custom criterion"
              />
              {customErrors.criterion && (
                <p className="text-xs text-destructive">{customErrors.criterion}</p>
              )}
            </div>
            <div>
              <Input
                placeholder="match value (e.g. -i /wp-admin)"
                value={custom.value}
                onChange={(e) => setCustom({ ...custom, value: e.target.value })}
                className="w-64"
                aria-label="custom match value"
              />
              {customErrors.value && (
                <p className="text-xs text-destructive">{customErrors.value}</p>
              )}
            </div>
            <Button onClick={() => void addCustomRule()} disabled={pending}>
              {pending ? "Working…" : "Add rule"}
            </Button>
          </div>
        </div>
      </section>

      {/* Bot management */}
      <section className="space-y-2">
        <div className="text-sm font-semibold">Bot management</div>
        <p className="text-xs text-muted-foreground">
          Signatures match the User-Agent header. Blocking compares against
          the blocked list; the verified-bots mode blocks everything that
          looks automated unless it is on the allowlist.
        </p>
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Protection</th>
                <th className="px-3 py-2">Behaviour</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-border">
                <td className="px-3 py-2 font-medium">Block bad bots</td>
                <td className="px-3 py-2 text-muted-foreground">
                  Denies the blocked signatures below.
                </td>
                <td className="px-3 py-2">
                  <Badge variant={findDenyIndex(rules, condBotBlock()) >= 0 ? "success" : "secondary"}>
                    {findDenyIndex(rules, condBotBlock()) >= 0 ? "active" : "off"}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    size="xs"
                    variant={findDenyIndex(rules, condBotBlock()) >= 0 ? "destructive" : "default"}
                    disabled={pending}
                    onClick={() => {
                      const active = findDenyIndex(rules, condBotBlock()) >= 0
                      void toggleBundle(
                        !active,
                        [BOT_BLOCK_ACL],
                        condBotBlock(),
                        blockedSigs.length === 0
                          ? DEFAULT_BLOCKED_BOTS.map((s) => ({
                              acl_name: BOT_BLOCK_ACL,
                              criterion: "req.hdr(user-agent)",
                              value: aclValueForSignature(s),
                            }))
                          : undefined,
                        "Block bad bots",
                      )
                    }}
                  >
                    {findDenyIndex(rules, condBotBlock()) >= 0 ? "Disable" : "Enable"}
                  </Button>
                </td>
              </tr>
              <tr className="border-t border-border">
                <td className="px-3 py-2 font-medium">Verified bots only</td>
                <td className="px-3 py-2 text-muted-foreground">
                  Blocks generic automation (bot/crawl/spider/scan UAs) unless
                  the agent is allowlisted below.
                </td>
                <td className="px-3 py-2">
                  <Badge
                    variant={findDenyIndex(rules, BOT_DETECT_ACL) >= 0 ? "success" : "secondary"}
                  >
                    {findDenyIndex(rules, BOT_DETECT_ACL) >= 0 ? "active" : "off"}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    size="xs"
                    variant={findDenyIndex(rules, BOT_DETECT_ACL) >= 0 ? "destructive" : "default"}
                    disabled={pending}
                    onClick={() => {
                      const active = findDenyIndex(rules, BOT_DETECT_ACL) >= 0
                      void toggleBundle(
                        !active,
                        [BOT_DETECT_ACL, BOT_ALLOW_ACL],
                        condBotUnknown(),
                        [
                          BOT_DETECT_LINE,
                          ...(verifiedSigs.length === 0
                            ? DEFAULT_VERIFIED_BOTS.map((s) => ({
                                acl_name: BOT_ALLOW_ACL,
                                criterion: "req.hdr(user-agent)",
                                value: aclValueForSignature(s),
                              }))
                            : []),
                        ],
                        "Verified bots only",
                      )
                    }}
                  >
                    {findDenyIndex(rules, BOT_DETECT_ACL) >= 0 ? "Disable" : "Enable"}
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <SignatureList
            title="Blocked bot signatures"
            rows={blockedSigs}
            input={newSig}
            setInput={setNewSig}
            onAdd={() => void addSignature(BOT_BLOCK_ACL, newSig, () => setNewSig(""))}
            onRemove={(index, sig) => void removeSignature(BOT_BLOCK_ACL, index, sig)}
            pending={pending}
          />
          <SignatureList
            title="Verified (allowlisted) bots"
            rows={verifiedSigs}
            input={newVerified}
            setInput={setNewVerified}
            onAdd={() => void addSignature(BOT_ALLOW_ACL, newVerified, () => setNewVerified(""))}
            onRemove={(index, sig) => void removeSignature(BOT_ALLOW_ACL, index, sig)}
            pending={pending}
          />
        </div>
      </section>

      {/* IP access control */}
      <section className="space-y-2">
        <div className="text-sm font-semibold">IP access control</div>
        <p className="text-xs text-muted-foreground">
          Source-IP lists as a single named ACL (one entry per line or space;
          CIDRs like 10.0.0.0/8, plain IPs or hostnames). Country lists from
          e.g. ipdeny.com can be pasted here for geo blocking.
        </p>
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Protection</th>
                <th className="px-3 py-2">Behaviour</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-border">
                <td className="px-3 py-2 font-medium">Block listed sources</td>
                <td className="px-3 py-2 text-muted-foreground">
                  Denies every source in the deny list below.
                </td>
                <td className="px-3 py-2">
                  <Badge variant={findDenyIndex(rules, IP_DENY_ACL) >= 0 ? "success" : "secondary"}>
                    {findDenyIndex(rules, IP_DENY_ACL) >= 0 ? "active" : "off"}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    size="xs"
                    variant={findDenyIndex(rules, IP_DENY_ACL) >= 0 ? "destructive" : "default"}
                    disabled={pending}
                    onClick={() => {
                      const active = findDenyIndex(rules, IP_DENY_ACL) >= 0
                      void toggleBundle(
                        !active,
                        [IP_DENY_ACL],
                        condIpDeny(),
                        undefined,
                        "Block listed sources",
                        IP_DENY_ACL,
                      )
                    }}
                  >
                    {findDenyIndex(rules, IP_DENY_ACL) >= 0 ? "Disable" : "Enable"}
                  </Button>
                </td>
              </tr>
              <tr className="border-t border-border">
                <td className="px-3 py-2 font-medium">Allow only listed sources</td>
                <td className="px-3 py-2 text-muted-foreground">
                  Denies everything not in the allow list below.
                </td>
                <td className="px-3 py-2">
                  <Badge variant={findDenyIndex(rules, IP_ALLOW_ACL) >= 0 ? "success" : "secondary"}>
                    {findDenyIndex(rules, IP_ALLOW_ACL) >= 0 ? "active" : "off"}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    size="xs"
                    variant={findDenyIndex(rules, IP_ALLOW_ACL) >= 0 ? "destructive" : "default"}
                    disabled={pending}
                    onClick={() => {
                      const active = findDenyIndex(rules, IP_ALLOW_ACL) >= 0
                      void toggleBundle(
                        !active,
                        [IP_ALLOW_ACL],
                        condIpAllowOnly(),
                        undefined,
                        "Allow only listed sources",
                        IP_ALLOW_ACL,
                      )
                    }}
                  >
                    {findDenyIndex(rules, IP_ALLOW_ACL) >= 0 ? "Disable" : "Enable"}
                  </Button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <CidrEditor
            title="Deny list"
            aclName={IP_DENY_ACL}
            acls={acls}
            pending={pending}
            onSave={(raw) => void saveCidrList(IP_DENY_ACL, raw, "Deny list")}
          />
          <CidrEditor
            title="Allow list"
            aclName={IP_ALLOW_ACL}
            acls={acls}
            pending={pending}
            onSave={(raw) => void saveCidrList(IP_ALLOW_ACL, raw, "Allow list")}
          />
        </div>
      </section>

      {/* Deep inspection (SPOE/Coraza) */}
      <section className="space-y-2">
        <div className="text-sm font-semibold">Deep inspection (SPOE / Coraza)</div>
        <div className="rounded-lg border border-border p-3">
          <p className="mb-2 text-xs text-muted-foreground">
            Community HAProxy offloads deep WAF inspection to a Coraza agent
            over the Stream Processing Offload Engine. Review the generated
            snippets, adapt paths and addresses, then apply them on the host
            (they are deliberately <em>not</em> pushed by the UI).
          </p>
          <SnippetBlock
            title={`haproxy.cfg — frontend ${effectiveName}`}
            content={haproxyFilterSnippet({
              frontend: effectiveName,
              agentAddress: "127.0.0.1:9000",
              spoeConfigPath: "/etc/haproxy/spoe-coraza.conf",
            })}
          />
          <SnippetBlock
            title="spoe-coraza.conf"
            content={spoeConfigSnippet({
              frontend: effectiveName,
              agentAddress: "127.0.0.1:9000",
              spoeConfigPath: "/etc/haproxy/spoe-coraza.conf",
            })}
          />
          <SnippetBlock title="coraza-spoa config.yaml" content={corazaAgentSnippet()} />
        </div>
      </section>
    </div>
  )
}

function SnippetBlock({ title, content }: { title: string; content: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="mt-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{title}</span>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            navigator.clipboard.writeText(content).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="max-h-52 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-4">
        {content}
      </pre>
    </div>
  )
}
function CidrEditor({
  title,
  aclName,
  acls,
  pending,
  onSave,
}: {
  title: string
  aclName: string
  acls: AclLine[]
  pending: boolean
  onSave: (raw: string) => void
}) {
  const serverValue = acls
    .filter((a) => a.acl_name === aclName)
    .map((a) => a.value ?? "")
    .join(" ")
  const [draft, setDraft] = useState<string | null>(null)
  // keep the editor in sync with the server until the user starts typing
  const value = draft ?? serverValue
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 text-sm font-medium">{title}</div>
      <textarea
        className="h-32 w-full rounded-md border border-border bg-background p-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={"10.0.0.0/8\n192.168.1.1\n203.0.113.0/24"}
        aria-label={title}
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {value.split(/[\s,]+/).filter(Boolean).length} entries
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || draft === null}
          onClick={() => onSave(value)}
        >
          Save list
        </Button>
      </div>
    </div>
  )
}

function SignatureList({
  title,
  rows,
  input,
  setInput,
  onAdd,
  onRemove,
  pending,
}: {
  title: string
  rows: { index: number; signature: string }[]
  input: string
  setInput: (v: string) => void
  onAdd: () => void
  onRemove: (index: number, signature: string) => void
  pending: boolean
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 text-sm font-medium">{title}</div>
      <div className="max-h-48 space-y-1 overflow-auto">
        {rows.length === 0 && (
          <p className="text-xs text-muted-foreground">No signatures yet.</p>
        )}
        {rows.map((r) => (
          <div key={r.index} className="flex items-center justify-between text-sm">
            <span className="font-mono text-xs">{r.signature}</span>
            <Button
              size="xs"
              variant="ghost"
              disabled={pending}
              onClick={() => onRemove(r.index, r.signature)}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Input
          placeholder="user-agent substring"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          className="h-8 flex-1"
          aria-label={title}
        />
        <Button size="sm" variant="outline" onClick={onAdd} disabled={pending || !input.trim()}>
          Add
        </Button>
      </div>
    </div>
  )
}

function SectionPicker({
  parentType,
  setParentType,
  options,
  effectiveName,
  setParentName,
}: {
  parentType: ParentType
  setParentType: (v: ParentType) => void
  options: { name: string }[]
  effectiveName: string
  setParentName: (v: string) => void
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
          <SelectTrigger className="w-[130px]" aria-label="waf section type">
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
          <SelectTrigger className="w-[200px]" aria-label="waf section name">
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
