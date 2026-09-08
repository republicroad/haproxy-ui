import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { actorFromRequest } from "#/lib/auth"
import { insertChange } from "#/lib/db"
import { proxyToNode } from "#/lib/dataplane/proxy"

const fixSchema = z.object({
  fix: z.enum(["enable-checks"]),
})

async function dp(
  nodeId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const req = new Request("http://internal/advisor-fix", {
    method,
    headers:
      body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return proxyToNode(nodeId, req, path)
}

/**
 * One-click advisor remediations. Currently: enable-checks — turn on
 * active health checks for every server in every backend that has them
 * disabled, in a single validated transaction (recorded in history).
 */
export const Route = createFileRoute("/api/nodes/$id/advisor/fix")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 })
        }
        const parsed = fixSchema.safeParse(body)
        if (!parsed.success || parsed.data.fix !== "enable-checks") {
          return Response.json({ error: "unknown fix" }, { status: 400 })
        }

        const verRes = await dp(params.id, "GET", "services/haproxy/configuration/version")
        if (!verRes.ok) {
          return Response.json({ error: "cannot reach dataplaneapi" }, { status: 502 })
        }
        const version = Number((await verRes.text()).trim())
        const txRes = await dp(
          params.id,
          "POST",
          `services/haproxy/transactions?version=${version}`,
        )
        if (!txRes.ok) {
          return Response.json({ error: "cannot open transaction" }, { status: 502 })
        }
        const tx = (await txRes.json()) as { id: string }
        const cancel = () =>
          dp(params.id, "DELETE", `services/haproxy/transactions/${tx.id}`).catch(() => {})

        try {
          const besRes = await dp(params.id, "GET", "services/haproxy/configuration/backends")
          if (!besRes.ok) throw new Error("cannot read backends")
          const besParsed = JSON.parse(await besRes.text()) as unknown
          const bes = (
            Array.isArray(besParsed)
              ? besParsed
              : ((besParsed as { data?: { name?: string }[] }).data ?? [])
          ).filter((b): b is { name: string } => Boolean(b.name))

          let fixed = 0
          let total = 0
          for (const b of bes.slice(0, 100)) {
            const srvRes = await dp(
              params.id,
              "GET",
              `services/haproxy/configuration/backends/${encodeURIComponent(b.name)}/servers`,
            )
            if (!srvRes.ok) continue
            const srvParsed = JSON.parse(await srvRes.text()) as unknown
            const servers = (
              Array.isArray(srvParsed)
                ? srvParsed
                : ((srvParsed as { data?: { name?: string; check?: string }[] }).data ?? [])
            ).filter((s): s is { name: string; check?: string } => Boolean(s.name))
            for (const s of servers) {
              total++
              if (s.check === "enabled") continue
              const put = await dp(
                params.id,
                "PUT",
                `services/haproxy/configuration/backends/${encodeURIComponent(b.name)}/servers/${encodeURIComponent(s.name)}?transaction_id=${encodeURIComponent(tx.id)}`,
                { check: "enabled" },
              )
              if (!put.ok) throw new Error(`failed to update ${b.name}/${s.name}`)
              fixed++
            }
          }

          const commit = await dp(params.id, "PUT", `services/haproxy/transactions/${tx.id}`)
          if (!commit.ok) {
            await cancel()
            return Response.json({ error: "commit failed (haproxy -c)" }, { status: 502 })
          }

          if (fixed > 0) {
            insertChange({
              id: crypto.randomUUID(),
              nodeId: params.id,
              ts: Date.now(),
              kind: "update",
              resource: "server",
              target: `${fixed} server(s): checks enabled`,
              parent: null,
              payload: JSON.stringify({ fix: "enable-checks", fixed, total }),
              txId: tx.id,
              reverted: 0,
              rawAfter: null,
              actor: actorFromRequest(request),
            })
          }
          return Response.json({ ok: true, fixed, total })
        } catch (e) {
          await cancel()
          return Response.json({ error: (e as Error).message }, { status: 502 })
        }
      },
    },
  },
})
