import { createFileRoute } from "@tanstack/react-router"
import { isGlobalAdmin } from "#/lib/auth"
import { listActiveSessions } from "#/lib/db"

/** Active (non-revoked) sessions — global admins only. */
export const Route = createFileRoute("/api/sessions")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isGlobalAdmin(request)) {
          return Response.json({ error: "forbidden" }, { status: 403 })
        }
        return Response.json(listActiveSessions())
      },
    },
  },
})
