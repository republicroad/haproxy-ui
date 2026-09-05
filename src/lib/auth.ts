import { createHmac, timingSafeEqual } from "node:crypto"

export const SESSION_COOKIE = "hui_session"
const SESSION_TTL_MS = 7 * 86_400_000

export function authEnabled(): boolean {
  return Boolean(process.env.HAPROXY_UI_USER && process.env.HAPROXY_UI_PASS)
}

function sessionSecret(): string {
  const explicit = process.env.HAPROXY_UI_SECRET
  if (explicit) return explicit
  return createHmac("sha256", "haproxy-ui-session")
    .update(`${process.env.HAPROXY_UI_USER}:${process.env.HAPROXY_UI_PASS}`)
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

export function verifyCredentials(user: string, pass: string): boolean {
  return (
    authEnabled() &&
    user === process.env.HAPROXY_UI_USER &&
    pass === process.env.HAPROXY_UI_PASS
  )
}

/** Signed, stateless session token: base64url({exp,iat}).hmac */
export function createSessionToken(): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, iat: Date.now() }),
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

export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token) return false
  const dot = token.lastIndexOf(".")
  if (dot <= 0) return false
  const payload = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  if (!safeEqual(sign(payload), sig)) return false
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      exp: number
      iat?: number
    }
    if (typeof parsed.exp !== "number" || parsed.exp <= Date.now()) return false
    if (parsed.iat !== undefined && parsed.iat <= revokedBefore) return false
    return true
  } catch {
    return false
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

export function sessionSetCookieHeader(): string {
  return `${SESSION_COOKIE}=${createSessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`
}

export function sessionClearCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
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
