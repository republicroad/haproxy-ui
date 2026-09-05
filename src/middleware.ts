import { createMiddleware } from "@tanstack/react-start"
import {
  authEnabled,
  readSessionCookie,
  verifySessionToken,
} from "#/lib/auth"

/**
 * Global request guard. Active only when HAPROXY_UI_USER + HAPROXY_UI_PASS
 * are set. /login and /api/auth/* stay public; everything else requires a
 * valid session cookie (401 for /api/*, redirect for pages).
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

  if (verifySessionToken(readSessionCookie(request))) return next()

  if (path.startsWith("/api/")) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }
  const loginUrl = new URL("/login", url.origin)
  if (path !== "/") loginUrl.searchParams.set("from", path)
  return Response.redirect(loginUrl.toString(), 302)
})
