import { createFileRoute } from "@tanstack/react-router"
import { getNode, insertChange } from "#/lib/db"
import { actorFromRequest } from "#/lib/auth"
import { publish } from "#/lib/events"
import { proxyToNode } from "#/lib/dataplane/proxy"
import { exportNodeConfig } from "#/lib/configExport"

async function dpJson<T>(
  nodeId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: T | null; text: string }> {
  const req = new Request("http://internal/config", {
    method,
    headers:
      body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const res = await proxyToNode(nodeId, req, path)
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, json: json as T | null, text }
}

function unwrap<T>(x: T | { data: T } | null): T | null {
  if (x && typeof x === "object" && !Array.isArray(x) && "data" in x) {
    return (x as { data: T }).data
  }
  return x as T
}

type AnyConfig = Record<string, unknown> & { name: string }

export const Route = createFileRoute("/api/nodes/$id/config")({
  server: {
    handlers: {
      /** Export the node's frontends + backends (with servers) as a JSON bundle. */
      GET: async ({ params }) => {
        const node = getNode(params.id)
        if (!node) {
          return Response.json({ error: "node not found" }, { status: 404 })
        }
        const result = await exportNodeConfig(params.id)
        if (!result.ok) {
          return Response.json(
            { error: result.error },
            { status: result.error === "node not found" ? 404 : 502 },
          )
        }
        return Response.json(result.bundle, {
          headers: {
            "content-disposition": `attachment; filename="haproxy-config-${node.name}.json"`,
          },
        })
      },
      /** Import a config bundle previously produced by GET. */
      POST: async ({ params, request }) => {
        const node = getNode(params.id)
        if (!node) {
          return Response.json({ error: "node not found" }, { status: 404 })
        }
        let bundle: {
          frontends?: AnyConfig[]
          backends?: (AnyConfig & { servers?: AnyConfig[] })[]
          conflict?: "skip" | "overwrite"
        }
        try {
          bundle = await request.json()
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 })
        }
        const conflict = bundle.conflict === "overwrite" ? "overwrite" : "skip"
        const fes = bundle.frontends ?? []
        const bes = bundle.backends ?? []
        if (fes.length === 0 && bes.length === 0) {
          return Response.json(
            { error: "bundle has no frontends or backends" },
            { status: 400 },
          )
        }

        const [fesRes, besRes] = await Promise.all([
          dpJson<AnyConfig[]>(
            params.id,
            "GET",
            "services/haproxy/configuration/frontends",
          ),
          dpJson<AnyConfig[]>(
            params.id,
            "GET",
            "services/haproxy/configuration/backends",
          ),
        ])
        const tFes = unwrap<AnyConfig[]>(fesRes.json) ?? []
        const tBes = unwrap<AnyConfig[]>(besRes.json) ?? []
        const tFeNames = new Set(tFes.map((f) => f.name))
        const tBeNames = new Set(tBes.map((b) => b.name))

        const created: string[] = []
        const skipped: string[] = []
        const metas: {
          kind: "create"
          resource: "frontend" | "backend" | "server"
          target: string
          parent?: string
          payload: unknown
        }[] = []

        const versionRes = await dpJson<number>(
          params.id,
          "GET",
          "services/haproxy/configuration/version",
        )
        const version = versionRes.json
        const txRes = await dpJson<{ id: string }>(
          params.id,
          "POST",
          `services/haproxy/transactions?version=${version}`,
        )
        const tx = txRes.json
        if (txRes.status !== 201 || !tx?.id) {
          return Response.json(
            { error: `cannot create transaction: ${txRes.text}` },
            { status: 502 },
          )
        }
        const txPath = (p: string) => `${p}?transaction_id=${encodeURIComponent(tx.id)}`

        try {
          for (const b of bes) {
            const exists = tBeNames.has(b.name)
            if (exists && conflict === "skip") {
              skipped.push(`backend/${b.name}`)
            } else {
              if (exists) {
                await dpJson(
                  params.id,
                  "DELETE",
                  txPath(
                    `services/haproxy/configuration/backends/${encodeURIComponent(b.name)}`,
                  ),
                )
              }
              const { servers: _s, ...bePayload } = b
              const r = await dpJson(
                params.id,
                "POST",
                txPath("services/haproxy/configuration/backends"),
                bePayload,
              )
              if (r.status >= 400) throw new Error(`backend ${b.name}: ${r.text}`)
              created.push(`backend/${b.name}`)
              metas.push({
                kind: "create",
                resource: "backend",
                target: b.name,
                payload: bePayload,
              })
            }
            for (const s of b.servers ?? []) {
              if (conflict === "skip") {
                const srvRes = await dpJson<AnyConfig[]>(
                  params.id,
                  "GET",
                  `services/haproxy/configuration/backends/${encodeURIComponent(b.name)}/servers`,
                )
                const names = new Set(
                  (unwrap<AnyConfig[]>(srvRes.json) ?? []).map((x) => x.name),
                )
                if (names.has(s.name)) {
                  skipped.push(`server/${b.name}/${s.name}`)
                  continue
                }
              }
              const r = await dpJson(
                params.id,
                "POST",
                txPath(
                  `services/haproxy/configuration/backends/${encodeURIComponent(b.name)}/servers`,
                ),
                s,
              )
              if (r.status >= 400) {
                throw new Error(`server ${b.name}/${s.name}: ${r.text}`)
              }
              created.push(`server/${b.name}/${s.name}`)
              metas.push({
                kind: "create",
                resource: "server",
                target: s.name,
                parent: b.name,
                payload: s,
              })
            }
          }
          for (const f of fes) {
            if (tFeNames.has(f.name)) {
              if (conflict === "skip") {
                skipped.push(`frontend/${f.name}`)
                continue
              }
              await dpJson(
                params.id,
                "DELETE",
                txPath(
                  `services/haproxy/configuration/frontends/${encodeURIComponent(f.name)}`,
                ),
              )
            }
            const r = await dpJson(
              params.id,
              "POST",
              txPath("services/haproxy/configuration/frontends"),
              f,
            )
            if (r.status >= 400) throw new Error(`frontend ${f.name}: ${r.text}`)
            created.push(`frontend/${f.name}`)
            metas.push({
              kind: "create",
              resource: "frontend",
              target: f.name,
              payload: f,
            })
          }
          const commit = await dpJson(
            params.id,
            "PUT",
            `services/haproxy/transactions/${tx.id}`,
          )
          if (commit.status >= 400) {
            throw new Error(`commit failed: ${commit.text}`)
          }
        } catch (e) {
          await dpJson(
            params.id,
            "DELETE",
            `services/haproxy/transactions/${tx.id}`,
          ).catch(() => {})
          return Response.json(
            { error: (e as Error).message },
            { status: 502 },
          )
        }

        if (metas.length > 0) {
          try {
            const actor = actorFromRequest(request)
            const rawRes = await dpJson<string>(
              params.id,
              "GET",
              "services/haproxy/configuration/raw",
            )
            const raw = rawRes.text.slice(0, 200_000)
            const ts = Date.now()
            for (const m of metas) {
              insertChange({
                id: crypto.randomUUID(),
                nodeId: params.id,
                ts,
                kind: m.kind,
                resource: m.resource,
                target: m.target,
                parent: m.parent ?? null,
                payload: JSON.stringify(m.payload),
                txId: tx.id,
                reverted: 0,
                rawAfter: raw,
                actor,
              })
            }
            publish({ type: "change", nodeId: params.id })
          } catch {
            // history recording must never break the import itself
          }
        }

        return Response.json({ created, skipped }, { status: 201 })
      },
    },
  },
})
