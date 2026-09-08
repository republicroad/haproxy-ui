import { createFileRoute } from "@tanstack/react-router"
import { isGlobalAdmin } from "#/lib/auth"
import { revokeSession } from "#/lib/db"

export const Route = createFileRoute("/api/sessions/$id")({
  server: {
    handlers: {
      DELETE: async ({ params, request }) => {
        if (!isGlobalAdmin(request)) {
          return Response.json({ error: "forbidden" }, { status: 403 })
        }
        revokeSession(params.id)
        return Response.json({ ok: true })
      },
    },
  },
})
