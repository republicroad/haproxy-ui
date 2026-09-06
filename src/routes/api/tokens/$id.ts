import { createFileRoute } from "@tanstack/react-router"
import { roleFromRequest } from "#/lib/auth"
import { deleteApiToken } from "#/lib/db"

export const Route = createFileRoute("/api/tokens/$id")({
  server: {
    handlers: {
      DELETE: async ({ params, request }) => {
        if (roleFromRequest(request) !== "admin") {
          return Response.json({ error: "forbidden" }, { status: 403 })
        }
        deleteApiToken(params.id)
        return Response.json({ ok: true })
      },
    },
  },
})
