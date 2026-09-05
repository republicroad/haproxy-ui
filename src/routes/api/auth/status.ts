import { createFileRoute } from "@tanstack/react-router"
import { authEnabled, sessionFromRequest } from "#/lib/auth"

/** Public: tells the UI whether login is configured and who is signed in. */
export const Route = createFileRoute("/api/auth/status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!authEnabled()) {
          // local single-user mode behaves like an implicit admin
          return Response.json({ enabled: false, username: null, role: "admin" })
        }
        const session = sessionFromRequest(request)
        return Response.json({
          enabled: true,
          username: session?.username ?? null,
          role: session?.role ?? null,
        })
      },
    },
  },
})
