import { createFileRoute } from "@tanstack/react-router"
import { authEnabled } from "#/lib/auth"

/** Public: tells the UI whether login is configured. */
export const Route = createFileRoute("/api/auth/status")({
  server: {
    handlers: {
      GET: async () => {
        return Response.json({ enabled: authEnabled() })
      },
    },
  },
})
