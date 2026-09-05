import { createFileRoute } from "@tanstack/react-router"
import { revokeAllSessions, sessionClearCookieHeader } from "#/lib/auth"

export const Route = createFileRoute("/api/auth/logout")({
  server: {
    handlers: {
      POST: async () => {
        revokeAllSessions()
        return Response.json(
          { ok: true },
          { headers: { "set-cookie": sessionClearCookieHeader() } },
        )
      },
    },
  },
})
