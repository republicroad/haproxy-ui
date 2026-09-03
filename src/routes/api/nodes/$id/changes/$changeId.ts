import { createFileRoute } from "@tanstack/react-router"
import { getChange } from "#/lib/db"

export const Route = createFileRoute("/api/nodes/$id/changes/$changeId")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const change = getChange(params.changeId)
        if (!change || change.nodeId !== params.id) {
          return Response.json({ error: "not found" }, { status: 404 })
        }
        return Response.json(change)
      },
    },
  },
})
