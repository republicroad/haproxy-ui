import { createFileRoute } from "@tanstack/react-router"
import { dpJson } from "#/lib/configExport"
import { normalizeFrontends, normalizeBackends } from "#/lib/normalize"
import { analyzeConfig, type Finding } from "#/lib/advisor"
import type { Frontend, Backend } from "#/lib/types"

/**
 * Configuration best-practice advisor. Fetches the node's sections and
 * rule collections, then runs the static analysis in #/lib/advisor.
 */
export const Route = createFileRoute("/api/nodes/$id/advisor")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const fesRes = await dpJson<Frontend[]>(
          params.id,
          "services/haproxy/configuration/frontends",
        ).catch(() => null)
        const besRes = await dpJson<Backend[]>(
          params.id,
          "services/haproxy/configuration/backends",
        ).catch(() => null)
        const frontends = normalizeFrontends(fesRes?.json ?? []).filter(
          (f) => !f.name.startsWith("_"),
        )
        const backends = normalizeBackends(besRes?.json ?? []).filter(
          (b) => !b.name.startsWith("_"),
        )

        const [switching, logTargets, beRules] = await Promise.all([
          Promise.all(
            frontends.map(async (f) => {
              const rules = await dpJson<{ name?: string }[]>(
                params.id,
                `services/haproxy/configuration/frontends/${encodeURIComponent(f.name)}/backend_switching_rules`,
              )
                .then((r) => r.json ?? [])
                .catch(() => [])
              return [f.name, rules.map((r) => r.name ?? "").filter(Boolean)] as const
            }),
          ),
          Promise.all(
            frontends.map(async (f) => {
              const logs = await dpJson<unknown[]>(
                params.id,
                `services/haproxy/configuration/frontends/${encodeURIComponent(f.name)}/logs`,
              )
                .then((r) => r.json ?? [])
                .catch(() => [])
              return [f.name, logs.length] as const
            }),
          ),
          Promise.all(
            backends.map(async (b) => {
              const rules = await dpJson<{ type?: string }[]>(
                params.id,
                `services/haproxy/configuration/backends/${encodeURIComponent(b.name)}/http_request_rules`,
              )
                .then((r) => r.json ?? [])
                .catch(() => [])
              return [b.name, rules] as const
            }),
          ),
        ])

        const findings: Finding[] = analyzeConfig({
          frontends,
          backends,
          switchingTargets: Object.fromEntries(switching),
          logTargetCounts: Object.fromEntries(logTargets),
          backendRequestRules: Object.fromEntries(
            beRules.map(([name, rules]) => [
              name,
              rules.map((r) => ({ type: r.type ?? "" })),
            ]),
          ),
        })

        return Response.json({
          checkedAt: Date.now(),
          summary: {
            high: findings.filter((f) => f.severity === "high").length,
            medium: findings.filter((f) => f.severity === "medium").length,
            low: findings.filter((f) => f.severity === "low").length,
          },
          findings,
        })
      },
    },
  },
})
