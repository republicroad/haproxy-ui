import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { insertUpgradeRun, listUpgradeRuns, updateNode } from "#/lib/db"
import { actorFromRequest } from "#/lib/auth"
import { fieldErrors } from "#/lib/schemas"
import { exportNodeConfig } from "#/lib/configExport"
import { proxyToNode } from "#/lib/dataplane/proxy"

/**
 * HAProxy binary upgrade orchestration.
 *
 * dataplaneapi cannot replace the haproxy binary itself, so the UI
 * orchestrates the safe sequence around the operator's ( Ansible/ssh )
 * binary swap:
 *
 *  - prepare: snapshot the full config bundle (rollback artifact) and
 *    optionally drain all runtime servers on this node.
 *  - verify: re-probe the runtime version, refresh node state and record
 *    the outcome against the expected target version.
 */
const actionSchema = z.object({
  action: z.enum(["prepare", "verify"]),
  drain: z.boolean().default(false),
  targetVersion: z.string().trim().max(32).optional(),
})

async function runtimeVersion(nodeId: string): Promise<{ version: string | null; error: string | null }> {
  try {
    const res = await proxyToNode(
      nodeId,
      new Request("http://internal/upgrade-version", { method: "GET" }),
      "services/haproxy/runtime/info",
    )
    if (!res.ok) return { version: null, error: `HTTP ${res.status}` }
    const info = (await res.json()) as { version?: string }
    return { version: info.version ?? null, error: null }
  } catch (e) {
    return { version: null, error: (e as Error).message }
  }
}

export const Route = createFileRoute("/api/nodes/$id/upgrade")({
  server: {
    handlers: {
      GET: async ({ params }) => Response.json({ runs: listUpgradeRuns(params.id) }),
      POST: async ({ params, request }) => {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 })
        }
        const parsed = actionSchema.safeParse(body)
        if (!parsed.success) {
          return Response.json(
            { error: "validation failed", fields: fieldErrors(parsed.error) },
            { status: 400 },
          )
        }
        const { action, drain, targetVersion } = parsed.data

        if (action === "prepare") {
          const snapshot = await exportNodeConfig(params.id)
          let drained: { backend: string; server: string; ok: boolean }[] = []
          if (drain && snapshot.ok) {
            const backendsRes = await proxyToNode(
              params.id,
              new Request("http://internal/upgrade-backends", { method: "GET" }),
              "services/haproxy/configuration/backends",
            )
            if (backendsRes.ok) {
              const parsed2 = JSON.parse(await backendsRes.text()) as unknown
              const backends = (
                Array.isArray(parsed2)
                  ? parsed2
                  : ((parsed2 as { data?: { name?: string }[] }).data ?? [])
              ).filter((b): b is { name: string } => Boolean(b.name))
              drained = await Promise.all(
                backends.slice(0, 50).flatMap(async (b) => {
                  const listRes = await proxyToNode(
                    params.id,
                    new Request("http://internal/upgrade-servers", { method: "GET" }),
                    `services/haproxy/runtime/backends/${encodeURIComponent(b.name)}/servers`,
                  )
                  if (!listRes.ok) return []
                  const listParsed = JSON.parse(await listRes.text()) as unknown
                  const servers = (
                    Array.isArray(listParsed)
                      ? listParsed
                      : ((listParsed as { data?: { name?: string }[] }).data ?? [])
                  ).filter((s): s is { name: string } => Boolean(s.name))
                  return Promise.all(
                    servers.map(async (s) => {
                      const put = await proxyToNode(
                        params.id,
                        new Request("http://internal/upgrade-drain", {
                          method: "PUT",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ admin_state: "maint" }),
                        }),
                        `services/haproxy/runtime/backends/${encodeURIComponent(b.name)}/servers/${encodeURIComponent(s.name)}`,
                      )
                      return { backend: b.name, server: s.name, ok: put.ok }
                    }),
                  )
                }),
              ).then((groups) => groups.flat())
            }
          }
          const result = {
            step: "prepared" as const,
            snapshot: snapshot.ok
              ? { frontends: snapshot.bundle.frontends?.length ?? 0, backends: snapshot.bundle.backends?.length ?? 0 }
              : null,
            snapshotError: snapshot.ok ? null : snapshot.error,
            drained,
          }
          insertUpgradeRun({
            nodeId: params.id,
            ts: Date.now(),
            action: "prepare",
            fromVersion: null,
            toVersion: targetVersion ?? null,
            result: JSON.stringify(result),
            actor: actorFromRequest(request),
          })
          return Response.json(result)
        }

        // verify
        const probe = await runtimeVersion(params.id)
        if (probe.version) {
          updateNode(params.id, { haproxyVersion: probe.version, status: "up", lastSeen: Date.now() })
        }
        const match = Boolean(targetVersion && probe.version === targetVersion)
        const result = {
          step: "verified" as const,
          version: probe.version,
          error: probe.error,
          targetMatch: targetVersion ? match : null,
        }
        insertUpgradeRun({
          nodeId: params.id,
          ts: Date.now(),
          action: "verify",
          fromVersion: null,
          toVersion: targetVersion ?? null,
          result: JSON.stringify(result),
          actor: actorFromRequest(request),
        })
        return Response.json(result)
      },
    },
  },
})
