import { createFileRoute } from "@tanstack/react-router"
import { getChange, insertChange, markReverted } from "#/lib/db"
import { actorFromRequest } from "#/lib/auth"
import { proxyToNode } from "#/lib/dataplane/proxy"

async function dp(
  nodeId: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const req = new Request("http://internal/revert", {
    method,
    headers:
      body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return proxyToNode(nodeId, req, path)
}

export const Route = createFileRoute("/api/nodes/$id/changes/$changeId/revert")({
  server: {
    handlers: {
      POST: async ({ params, request }) => {
        const change = getChange(params.changeId)
        if (!change || change.nodeId !== params.id) {
          return Response.json({ error: "not found" }, { status: 404 })
        }
        if (change.reverted) {
          return Response.json({ error: "already reverted" }, { status: 409 })
        }
        if (change.kind !== "create" && change.kind !== "delete") {
          return Response.json(
            { error: `cannot revert a "${change.kind}" entry` },
            { status: 400 },
          )
        }

        const payload = change.payload ? JSON.parse(change.payload) : null
        const ops: Array<{ method: string; path: string; body?: unknown }> = []
        if (change.kind === "create") {
          if (change.resource === "frontend") {
            ops.push({
              method: "DELETE",
              path: `services/haproxy/configuration/frontends/${encodeURIComponent(change.target)}`,
            })
          } else if (change.resource === "backend") {
            ops.push({
              method: "DELETE",
              path: `services/haproxy/configuration/backends/${encodeURIComponent(change.target)}`,
            })
          } else if (change.parent) {
            ops.push({
              method: "DELETE",
              path: `services/haproxy/configuration/backends/${encodeURIComponent(change.parent)}/servers/${encodeURIComponent(change.target)}`,
            })
          }
        } else {
          if (!payload) {
            return Response.json(
              { error: "no payload recorded for this change" },
              { status: 400 },
            )
          }
          if (change.resource === "frontend") {
            ops.push({
              method: "POST",
              path: "services/haproxy/configuration/frontends",
              body: payload,
            })
          } else if (change.resource === "backend") {
            ops.push({
              method: "POST",
              path: "services/haproxy/configuration/backends",
              body: payload,
            })
          } else if (change.parent) {
            ops.push({
              method: "POST",
              path: `services/haproxy/configuration/backends/${encodeURIComponent(change.parent)}/servers`,
              body: payload,
            })
          }
        }
        if (ops.length === 0 || (change.resource === "server" && !change.parent)) {
          return Response.json({ error: "revert not supported for this entry" }, { status: 400 })
        }

        const verRes = await dp(params.id, "GET", "services/haproxy/configuration/version")
        if (!verRes.ok) {
          return Response.json(
            { error: `cannot read config version: ${await verRes.text()}` },
            { status: 502 },
          )
        }
        const version = Number((await verRes.text()).trim())
        const txRes = await dp(
          params.id,
          "POST",
          `services/haproxy/transactions?version=${version}`,
        )
        if (!txRes.ok) {
          return Response.json(
            { error: `cannot open transaction: ${await txRes.text()}` },
            { status: 502 },
          )
        }
        const tx = (await txRes.json()) as { id: string }
        const cancel = () =>
          dp(params.id, "DELETE", `services/haproxy/transactions/${tx.id}`).catch(() => {})

        for (const op of ops) {
          const sep = op.path.includes("?") ? "&" : "?"
          const res = await dp(
            params.id,
            op.method,
            `${op.path}${sep}transaction_id=${encodeURIComponent(tx.id)}`,
            op.body,
          )
          if (!res.ok) {
            await cancel()
            return Response.json(
              { error: `revert failed (${op.method} ${op.path}): ${await res.text()}` },
              { status: 502 },
            )
          }
        }
        const commit = await dp(params.id, "PUT", `services/haproxy/transactions/${tx.id}`)
        if (!commit.ok) {
          await cancel()
          return Response.json(
            { error: `commit failed: ${await commit.text()}` },
            { status: 502 },
          )
        }

        let rawAfter: string | null = null
        try {
          const rawRes = await dp(params.id, "GET", "services/haproxy/configuration/raw")
          if (rawRes.ok) rawAfter = (await rawRes.text()).slice(0, 200_000)
        } catch {
          // snapshot is best-effort
        }

        markReverted(change.id)
        const id = crypto.randomUUID()
        insertChange({
          id,
          nodeId: params.id,
          ts: Date.now(),
          kind: "revert",
          resource: change.resource,
          target: change.target,
          parent: change.parent,
          payload: null,
          txId: tx.id,
          reverted: 0,
          rawAfter,
          actor: actorFromRequest(request) ?? `revert-of:${change.id}`,
        })
        return Response.json({ ok: true, revertId: id })
      },
    },
  },
})
