import { createMiddleware } from "@tanstack/react-start"
import {
  authEnabled,
  identityFromRequest,
  isCrossSiteWrite,
  roleFromRequest,
  type IdentityScope,
} from "#/lib/auth"
import { getNode } from "#/lib/db"

/**
 * Extract the targeted node id from /api/nodes/:id[...] and
 * /api/dp/:nodeId/... request paths (null for fleet-wide endpoints).
 */
function nodeIdFromPath(path: string): string | null {
  let m = path.match(/^\/api\/nodes\/([^/]+)/)
  if (m) {
    const seg = decodeURIComponent(m[1])
    // fleet-wide verbs live under /api/nodes/* too — they are not node ids
    if (["diff", "export", "import"].includes(seg)) return null
    return seg
  }
  m = path.match(/^\/api\/dp\/([^/]+)/)
  if (m) return decodeURIComponent(m[1])
  return null
}

/** Group-scoped identities may only touch nodes in their own group. */
function scopeDeniedOnNode(scope: IdentityScope, nodeId: string | null): boolean {
  if (scope.kind !== "group") return false
  // fleet-wide endpoints are out of scope for group identities
  if (nodeId === null) return true
  const node = getNode(nodeId)
  return !node || node.group !== scope.group
}

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

    const identity = identityFromRequest(request)
    if (identity) {
      const method = request.method.toUpperCase()
      const write = method !== "GET" && method !== "HEAD" && method !== "OPTIONS"
      // read-only tokens: no writes at all, even for the admin role
      if (write && (identity.scope.kind === "readonly" || roleFromRequest(request) !== "admin")) {
        return Response.json(
          { error: "forbidden: this identity is read-only" },
          { status: 403 },
        )
      }
      // group-scoped identities (group admins / group tokens): node targeting
      if (scopeDeniedOnNode(identity.scope, nodeIdFromPath(path))) {
        return Response.json(
          { error: "forbidden: outside your node group" },
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
