import { createPublicKey, createVerify, randomBytes } from "node:crypto"
import { getUser, insertUser, updateUser } from "#/lib/db"
import { hashPassword } from "#/lib/auth"
import { readOidcEnv, type OidcConfig } from "./oidcEnv"

/**
 * OIDC (OAuth2 authorization-code) sign-in for enterprise identity
 * providers. Configuration is env-driven:
 *
 *   HAPROXY_UI_OIDC_ISSUER        https://idp.example.com
 *   HAPROXY_UI_OIDC_CLIENT_ID     haproxy-ui
 *   HAPROXY_UI_OIDC_CLIENT_SECRET ...
 *   HAPROXY_UI_OIDC_ADMIN_EMAILS  ops@example.com,boss@example.com
 *
 * Discovered via {issuer}/.well-known/openid-configuration. id_token
 * signatures are verified against the provider JWKS (RS256).
 */

export const OIDC_STATE_COOKIE = "hui_oidc_state"
const DISCOVERY_TTL_MS = 3_600_000

export function oidcConfig(): OidcConfig | null {
  return readOidcEnv()
}

export { isOidcConfigured } from "./oidcEnv"
export type { OidcConfig } from "./oidcEnv"

type Discovery = {
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

let discoveryCache: { at: number; doc: Discovery } | null = null

export async function getDiscovery(cfg: OidcConfig): Promise<Discovery> {
  if (discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) {
    return discoveryCache.doc
  }
  const res = await fetch(`${cfg.issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`)
  const doc = (await res.json()) as Discovery
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error("OIDC discovery document is missing required endpoints")
  }
  discoveryCache = { at: Date.now(), doc }
  return doc
}

export function newState(): string {
  return randomBytes(16).toString("hex")
}

export function buildAuthUrl(
  cfg: OidcConfig,
  discovery: Discovery,
  state: string,
  redirectUri: string,
): string {
  const url = new URL(discovery.authorization_endpoint)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", cfg.clientId)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("scope", "openid profile email")
  url.searchParams.set("state", state)
  return url.toString()
}

// --- id_token verification (RS256) ---

type JwtParts = {
  header: Record<string, unknown>
  payload: Record<string, unknown>
  sig: Buffer
  signed: string
}

function splitJwt(token: string): JwtParts | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], "base64url").toString()) as Record<string, unknown>,
      payload: JSON.parse(Buffer.from(parts[1], "base64url").toString()) as Record<string, unknown>,
      sig: Buffer.from(parts[2], "base64url"),
      signed: `${parts[0]}.${parts[1]}`,
    }
  } catch {
    return null
  }
}

type Jwk = { kty?: string; kid?: string; n?: string; e?: string }

export async function verifyIdToken(
  cfg: OidcConfig,
  discovery: Discovery,
  idToken: string,
): Promise<Record<string, unknown> | null> {
  const parts = splitJwt(idToken)
  if (!parts) return null
  if (parts.header.alg !== "RS256") return null
  const jwksRes = await fetch(discovery.jwks_uri, { signal: AbortSignal.timeout(10_000) })
  if (!jwksRes.ok) return null
  const jwks = (await jwksRes.json()) as { keys?: Jwk[] }
  const kid = typeof parts.header.kid === "string" ? parts.header.kid : undefined
  const jwk = (jwks.keys ?? []).find(
    (k) => k.kty === "RSA" && (kid === undefined || k.kid === kid),
  )
  if (!jwk?.n || !jwk?.e) return null
  const key = createPublicKey({
    key: jwk as unknown as import("node:crypto").JsonWebKey,
    format: "jwk",
  })
  const ok = createVerify("RSA-SHA256").update(parts.signed).verify(key, parts.sig)
  if (!ok) return null

  const { iss, aud, exp } = parts.payload as {
    iss?: string
    aud?: string | string[]
    exp?: number
  }
  if (iss !== cfg.issuer) return null
  const audiences = Array.isArray(aud) ? aud : [aud]
  if (!audiences.includes(cfg.clientId)) return null
  if (typeof exp !== "number" || exp <= Date.now() / 1000) return null
  return parts.payload
}

// --- token exchange + provisioning ---

export type TokenSet = { id_token: string; access_token?: string }

export async function exchangeCode(
  cfg: OidcConfig,
  discovery: Discovery,
  code: string,
  redirectUri: string,
): Promise<TokenSet | null> {
  const res = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) return null
  const body = (await res.json()) as { id_token?: string; access_token?: string }
  return body.id_token ? { id_token: body.id_token, access_token: body.access_token } : null
}

/**
 * Create or update the local user for a verified id_token claim set.
 * Email (or preferred_username) is the identity; configured admin emails
 * get the admin role, existing users keep their role unless promoted.
 */
export function provisionUser(cfg: OidcConfig, claims: Record<string, unknown>): string {
  const email = typeof claims.email === "string" ? claims.email : null
  const username =
    email ?? (typeof claims.preferred_username === "string" ? claims.preferred_username : null)
  if (!username) throw new Error("id_token has neither email nor preferred_username")

  const shouldBeAdmin = email !== null && cfg.adminEmails.includes(email.toLowerCase())
  const existing = getUser(username)
  if (!existing) {
    insertUser({
      username,
      // password logins stay impossible: unguessable scrypt hash
      passHash: hashPassword(randomBytes(32).toString("hex")),
      role: shouldBeAdmin ? "admin" : "viewer",
    })
  } else if (shouldBeAdmin && existing.role !== "admin") {
    updateUser(username, { role: "admin" })
  }
  return username
}

/** Reset the discovery cache (for tests). */
export function resetOidcCache(): void {
  discoveryCache = null
}
