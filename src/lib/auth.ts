import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import {
  getApiTokenByHash,
  getUser,
  insertApiToken,
  listUsers,
  touchApiToken,
} from "#/lib/db"

export const SESSION_COOKIE = "hui_session"
const SESSION_TTL_MS = 7 * 86_400_000

export type AuthMode = "users" | "env" | "off"
export type Role = "admin" | "viewer"

/** Which authentication backend is active. */
export function authMode(): AuthMode {
  if (process.env.HAPROXY_UI_USER && process.env.HAPROXY_UI_PASS) return "env"
  if (listUsers().length > 0) return "users"
  return "off"
}

/** Whether any authentication is active. */
export function authEnabled(): boolean {
  return authMode() !== "off"
}

/**
 * Verify login credentials. DB users take precedence; when no DB user
 * matches and the env single-user is configured, fall back to it.
 */
export function verifyCredentials(user: string, pass: string): {
  ok: boolean
  role: Role | null
} {
  const dbUser = getUser(user)
  if (dbUser) {
    return { ok: verifyScrypt(pass, dbUser.passHash), role: dbUser.role }
  }
  if (authMode() === "env") {
    const ok =
      user === process.env.HAPROXY_UI_USER && pass === process.env.HAPROXY_UI_PASS
    return { ok, role: ok ? "admin" : null }
  }
  return { ok: false, role: null }
}

function sessionSecret(): string {
  const explicit = process.env.HAPROXY_UI_SECRET
  if (explicit) return explicit
  return createHmac("sha256", "haproxy-ui-session")
    .update(`${process.env.HAPROXY_UI_USER ?? "db-users"}:${process.env.HAPROXY_UI_PASS ?? process.env.HAPROXY_UI_DB ?? "local"}`)
    .digest("hex")
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("hex")
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/** Signed, stateless session token: base64url({exp,iat,sub}).hmac */
export function createSessionToken(username: string): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, iat: Date.now(), sub: username }),
  ).toString("base64url")
  return `${payload}.${sign(payload)}`
}

/**
 * Runtime revocation point: sessions issued before this moment are rejected.
 * In-memory only (resets on restart) — enough to make logout immediate.
 */
let revokedBefore = 0

export function revokeAllSessions(): void {
  revokedBefore = Date.now()
}

export type SessionInfo = { username: string; role: Role }

export function verifySessionToken(token: string | undefined | null): SessionInfo | null {
  if (!token) return null
  const dot = token.lastIndexOf(".")
  if (dot <= 0) return null
  const payload = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  if (!safeEqual(sign(payload), sig)) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      exp: number
      iat?: number
      sub?: string
    }
    if (typeof parsed.exp !== "number" || parsed.exp <= Date.now()) return null
    if (parsed.iat !== undefined && parsed.iat <= revokedBefore) return null
    const username = typeof parsed.sub === "string" && parsed.sub ? parsed.sub : null
    if (!username) return null
    // env single-user sessions have no DB row
    if (username === process.env.HAPROXY_UI_USER && authMode() === "env") {
      return { username, role: "admin" }
    }
    const dbUser = getUser(username)
    if (!dbUser) return null
    return { username, role: dbUser.role }
  } catch {
    return null
  }
}

export function readSessionCookie(request: Request): string | undefined {
  const header = request.headers.get("cookie")
  if (!header) return undefined
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=")
    if (name === SESSION_COOKIE) return rest.join("=")
  }
  return undefined
}

export function sessionSetCookieHeader(username: string): string {
  const secure = process.env.HAPROXY_UI_COOKIE_SECURE === "true" ? "; Secure" : ""
  return `${SESSION_COOKIE}=${createSessionToken(username)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`
}

export function sessionClearCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

/** Session for the current request (username + role), or null. */
export function sessionFromRequest(request: Request): SessionInfo | null {
  return verifySessionToken(readSessionCookie(request))
}

// --- API tokens (Bearer) ---

export type NewApiToken = { id: string; token: string; name: string; role: Role }

/** Generate a new API token; only the SHA-256 hash is stored. */
export function mintApiToken(name: string, role: Role): NewApiToken {
  const token = `hui_${randomBytes(24).toString("hex")}`
  const tokenHash = createHash("sha256").update(token).digest("hex")
  const record = {
    id: crypto.randomUUID(),
    name,
    tokenHash,
    role,
    createdAt: Date.now(),
  }
  insertApiToken(record)
  return { id: record.id, token, name, role }
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function bearerFromRequest(request: Request): string | null {
  const header = request.headers.get("authorization")
  if (!header?.startsWith("Bearer ")) return null
  return header.slice(7).trim() || null
}

/**
 * Resolve the caller identity: session cookie first, then API token
 * (Authorization: Bearer). Returns username-like label + role.
 */
export function identityFromRequest(request: Request): SessionInfo | null {
  const session = sessionFromRequest(request)
  if (session) return session
  const bearer = bearerFromRequest(request)
  if (!bearer) return null
  const record = getApiTokenByHash(hashApiToken(bearer))
  if (!record) return null
  touchApiToken(record.id)
  return { username: `token:${record.name}`, role: record.role }
}

/** Audit actor: signed-in username or token name when auth is on, else null. */
export function actorFromRequest(request: Request): string | null {
  if (!authEnabled()) return null
  return identityFromRequest(request)?.username ?? null
}

/** Role of the caller; "admin" when auth is off (local single-user mode). */
export function roleFromRequest(request: Request): Role | null {
  if (!authEnabled()) return "admin"
  return identityFromRequest(request)?.role ?? null
}

// --- hardening ---

const SECURITY_HEADERS: Record<string, string> = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
}

/** Return a copy of `res` with the standard security headers applied. */
export function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v)
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

/**
 * CSRF defense-in-depth for state-changing requests: when the browser
 * supplies an Origin (or Referer) header it must match the request host.
 * Absent headers (curl, server-to-server) are allowed - CSRF relies on
 * the browser auto-attaching cookies, which non-browser clients don't do.
 */
export function isCrossSiteWrite(request: Request): boolean {
  const method = request.method.toUpperCase()
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false
  const url = new URL(request.url)
  const origin = request.headers.get("origin")
  if (origin) {
    try {
      if (new URL(origin).host !== url.host) return true
    } catch {
      return true
    }
  } else {
    const referer = request.headers.get("referer")
    if (referer) {
      try {
        if (new URL(referer).host !== url.host) return true
      } catch {
        return true
      }
    }
  }
  return false
}

// --- password hashing (scrypt) ---

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex")
  const hash = scryptSync(password, salt, 64).toString("hex")
  return `scrypt:${salt}:${hash}`
}

export function verifyScrypt(password: string, stored: string): boolean {
  if (!stored.startsWith("scrypt:")) return false
  const [, salt, expected] = stored.split(":")
  const actual = scryptSync(password, salt, 64).toString("hex")
  return safeEqual(actual, expected)
}

/** Naive fixed-window login rate limiting (per IP, in-memory). */
const attempts = new Map<string, { count: number; windowStart: number }>()
const WINDOW_MS = 60_000
const MAX_ATTEMPTS = 5

export function loginAllowed(ip: string): boolean {
  const now = Date.now()
  const rec = attempts.get(ip)
  if (!rec || now - rec.windowStart > WINDOW_MS) {
    attempts.set(ip, { count: 0, windowStart: now })
    return true
  }
  return rec.count < MAX_ATTEMPTS
}

export function recordLoginFailure(ip: string): void {
  const rec = attempts.get(ip)
  if (rec) rec.count++
  if (attempts.size > 10_000) attempts.clear()
}
