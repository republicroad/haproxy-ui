import { createFileRoute } from "@tanstack/react-router"
import { isOidcConfigured } from "#/lib/oidc"

/** Public probe for the login page: is SSO configured? */
export const Route = createFileRoute("/api/auth/oidc/status")({
  server: {
    handlers: {
      GET: async () => Response.json({ configured: isOidcConfigured() }),
    },
  },
})
