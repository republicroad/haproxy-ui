import { createFileRoute } from "@tanstack/react-router"
import { proxyToNode } from "#/lib/dataplane/proxy"
import { updateNode } from "#/lib/db"

export const Route = createFileRoute("/api/nodes/$id/test")({
  server: {
    handlers: {
      POST: async ({ params }) => {
        const res = await proxyToNode(
          params.id,
          new Request("http://internal/info", { method: "GET" }),
          "services/haproxy/runtime/info",
        )
        if (res.status !== 200) {
          let msg = "connection failed"
          try {
            const j = await res.json()
            msg = j.error ?? msg
          } catch {
            /* ignore */
          }
          updateNode(params.id, { status: "down", lastSeen: Date.now() })
          return Response.json({ ok: false, error: msg })
        }
        const info = await res.json()
        const version =
          info?.info?.version ?? info?.[0]?.info?.version ?? null
        updateNode(params.id, {
          status: "up",
          lastSeen: Date.now(),
          haproxyVersion: version,
        })
        return Response.json({ ok: true, version })
      },
    },
  },
})
