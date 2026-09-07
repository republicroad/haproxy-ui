import { createFileRoute } from "@tanstack/react-router"
import { OIDC_STATE_COOKIE, buildAuthUrl, getDiscovery, newState, oidcConfig } from "#/lib/oidc"

/**
 * Kick off the OIDC authorization-code flow: sets the anti-CSRF state
 * cookie and redirects to the provider.
 */
export const Route = createFileRoute("/api/auth/oidc/start")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const cfg = oidcConfig()
        if (!cfg) {
          return Response.json({ error: "OIDC is not configured" }, { status: 404 })
        }
        let discovery
        try {
          discovery = await getDiscovery(cfg)
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 502 })
        }
        const url = new URL(request.url)
        const state = newState()
        const redirectUri = `${url.origin}/api/auth/oidc/callback`
        const authUrl = buildAuthUrl(cfg, discovery, state, redirectUri)
        return new Response(null, {
          status: 302,
          headers: [
            ["location", authUrl],
            [
              "set-cookie",
              `${OIDC_STATE_COOKIE}=${state}; Path=/api/auth/oidc/callback; HttpOnly; SameSite=Lax; Max-Age=600`,
            ],
          ],
        })
      },
    },
  },
})
