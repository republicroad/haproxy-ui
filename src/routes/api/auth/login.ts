import { createFileRoute } from "@tanstack/react-router"
import {
  authEnabled,
  loginAllowed,
  recordLoginFailure,
  sessionSetCookieHeader,
  verifyCredentials,
} from "#/lib/auth"

export const Route = createFileRoute("/api/auth/login")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!authEnabled()) {
          return Response.json(
            { error: "auth not configured (set HAPROXY_UI_USER/HAPROXY_UI_PASS)" },
            { status: 400 },
          )
        }
        const ip =
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local"
        if (!loginAllowed(ip)) {
          return Response.json(
            { error: "too many attempts, try again in a minute" },
            { status: 429 },
          )
        }
        let body: { user?: string; pass?: string }
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 })
        }
        if (!verifyCredentials(body.user ?? "", body.pass ?? "")) {
          recordLoginFailure(ip)
          return Response.json({ error: "invalid credentials" }, { status: 401 })
        }
        return Response.json(
          { ok: true },
          { headers: { "set-cookie": sessionSetCookieHeader() } },
        )
      },
    },
  },
})
