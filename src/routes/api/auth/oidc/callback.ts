import { createFileRoute } from "@tanstack/react-router"
import { sessionSetCookieHeader } from "#/lib/auth"
import {
  OIDC_STATE_COOKIE,
  exchangeCode,
  getDiscovery,
  oidcConfig,
  provisionUser,
  verifyIdToken,
} from "#/lib/oidc"

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie")
  if (!header) return null
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=")
    if (k === name) return rest.join("=")
  }
  return null
}

/** OIDC redirect endpoint: code+state in, app session cookie out. */
export const Route = createFileRoute("/api/auth/oidc/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const cfg = oidcConfig()
        if (!cfg) {
          return Response.json({ error: "OIDC is not configured" }, { status: 404 })
        }
        const url = new URL(request.url)
        const code = url.searchParams.get("code")
        const state = url.searchParams.get("state")
        const cookieState = readCookie(request, OIDC_STATE_COOKIE)
        if (!code || !state || !cookieState || state !== cookieState) {
          return Response.json({ error: "invalid state" }, { status: 400 })
        }

        const redirectUri = `${url.origin}/api/auth/oidc/callback`
        try {
          const discovery = await getDiscovery(cfg)
          const tokens = await exchangeCode(cfg, discovery, code, redirectUri)
          if (!tokens) {
            return Response.json({ error: "token exchange failed" }, { status: 502 })
          }
          const claims = await verifyIdToken(cfg, discovery, tokens.id_token)
          if (!claims) {
            return Response.json({ error: "id_token verification failed" }, { status: 502 })
          }
          const username = provisionUser(cfg, claims)
          return new Response(null, {
            status: 302,
            headers: [
              ["location", "/"],
              ["set-cookie", sessionSetCookieHeader(username)],
              // state cookie is single-use
              [
                "set-cookie",
                `${OIDC_STATE_COOKIE}=; Path=/api/auth/oidc/callback; HttpOnly; SameSite=Lax; Max-Age=0`,
              ],
            ],
          })
        } catch (e) {
          return Response.json({ error: (e as Error).message }, { status: 502 })
        }
      },
    },
  },
})
