import { createMiddleware } from "@tanstack/react-start"
import {
  authEnabled,
  readSessionCookie,
  roleFromRequest,
  verifySessionToken,
} from "#/lib/auth"

/**
 * Global request guard. Active only when authentication is configured
 * (env single-user or DB users).
 *
 * Public: /login and /api/auth/*. Everything else requires a valid
 * session cookie. RBAC: `viewer` sessions may only perform GET/HEAD
 * requests (writes get 403); `admin` is unrestricted.
 */
export const authMiddleware = createMiddleware().server(async ({ request, next }) => {
  if (!authEnabled()) return next()

  const url = new URL(request.url)
  const path = url.pathname
  const isPublic =
    path === "/login" ||
    path === "/api/auth/login" ||
    path === "/api/auth/logout" ||
    path === "/api/auth/status"
  if (isPublic) return next()

  if (verifySessionToken(readSessionCookie(request))) {
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
})
