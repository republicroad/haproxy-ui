/**
 * OIDC environment configuration, dependency-free so both the auth core
 * and the OIDC flow can read it without import cycles.
 */
export type OidcConfig = {
  issuer: string
  clientId: string
  clientSecret: string
  adminEmails: string[]
}

export function readOidcEnv(): OidcConfig | null {
  const issuer = process.env.HAPROXY_UI_OIDC_ISSUER?.replace(/\/+$/, "")
  const clientId = process.env.HAPROXY_UI_OIDC_CLIENT_ID
  const clientSecret = process.env.HAPROXY_UI_OIDC_CLIENT_SECRET
  if (!issuer || !clientId || !clientSecret) return null
  return {
    issuer,
    clientId,
    clientSecret,
    adminEmails: (process.env.HAPROXY_UI_OIDC_ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  }
}

export function isOidcConfigured(): boolean {
  return readOidcEnv() !== null
}
