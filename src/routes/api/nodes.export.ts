import { createFileRoute } from "@tanstack/react-router"
import { listNodes } from "#/lib/db"

/** Export all nodes as JSON (credentials stripped). */
export const Route = createFileRoute("/api/nodes/export")({
  server: {
    handlers: {
      GET: async () => {
        const nodes = listNodes().map((n) => ({
          name: n.name,
          apiUrl: n.apiUrl,
          apiUser: n.apiUser,
        }))
        return Response.json(
          { exportedAt: new Date().toISOString(), nodes },
          {
            headers: {
              "content-disposition": `attachment; filename="haproxy-ui-nodes.json"`,
            },
          },
        )
      },
    },
  },
})
