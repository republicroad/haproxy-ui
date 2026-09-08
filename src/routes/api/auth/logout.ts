import { createFileRoute } from "@tanstack/react-router"
import { revokeCurrentSession, sessionClearCookieHeader } from "#/lib/auth"

export const Route = createFileRoute("/api/auth/logout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // revoke just this session in the registry (cookie alone is cleared too)
        revokeCurrentSession(request)
        return Response.json(
          { ok: true },
          { headers: { "set-cookie": sessionClearCookieHeader() } },
        )
      },
    },
  },
})
