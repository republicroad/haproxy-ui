import { createMiddleware } from "@tanstack/react-start"
import {
  authEnabled,
  identityFromRequest,
  isCrossSiteWrite,
  roleFromRequest,
} from "#/lib/auth"

/**
 * Global request guard + auth. Security response headers live in
 * vite.config (dev) and prod-server.mjs (prod); this middleware owns
 * authn/authz and CSRF same-origin enforcement (state-changing requests
 * from a foreign Origin/Referer are rejected).
 */
export const authMiddleware = createMiddleware().server(async ({ request, next }) => {
  if (isCrossSiteWrite(request)) {
    return Response.json({ error: "cross-site write rejected" }, { status: 403 })
  }

  const res = await (async () => {
    if (!authEnabled()) return next()

    const url = new URL(request.url)
    const path = url.pathname
    const isPublic =
      path === "/login" ||
      path === "/api/auth/login" ||
      path === "/api/auth/logout" ||
      path === "/api/auth/status" ||
      path === "/api/auth/oidc/status" ||
      path === "/api/auth/oidc/start" ||
      path === "/api/auth/oidc/callback"
    if (isPublic) return next()

    if (identityFromRequest(request)) {
      const method = request.method.toUpperCase()
      const write = method !== "GET" && method !== "HEAD" && method !== "OPTIONS"
      if (write && roleFromRequest(request) !== "admin") {
        return Response.json(
          { error: "forbidden: viewer role is read-only" },
          { status: 403 },
        )
      }
      return next()
    }

    if (path.startsWith("/api/")) {
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }
    const loginUrl = new URL("/login", url.origin)
    if (path !== "/") loginUrl.searchParams.set("from", path)
    return Response.redirect(loginUrl.toString(), 302)
  })()

  return res
})
