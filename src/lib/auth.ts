import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { getUser, listUsers } from "#/lib/db"

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
  return `${SESSION_COOKIE}=${createSessionToken(username)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`
}

export function sessionClearCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

/** Session for the current request (username + role), or null. */
export function sessionFromRequest(request: Request): SessionInfo | null {
  return verifySessionToken(readSessionCookie(request))
}

/** Audit actor: the signed-in username when auth is on, else null. */
export function actorFromRequest(request: Request): string | null {
  if (!authEnabled()) return null
  return sessionFromRequest(request)?.username ?? null
}

/** Role of the caller; "admin" when auth is off (local single-user mode). */
export function roleFromRequest(request: Request): Role | null {
  if (!authEnabled()) return "admin"
  return sessionFromRequest(request)?.role ?? null
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
