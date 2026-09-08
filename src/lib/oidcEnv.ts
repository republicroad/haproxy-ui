/**
 * OIDC environment configuration, dependency-free so both the auth core
 * and the OIDC flow can read it without import cycles.
 */
export type OidcConfig = {
  issuer: string
  clientId: string
  clientSecret: string
  adminEmails: string[]
  /** id_token claim carrying the user's group memberships (default "groups") */
  groupClaim: string
  /** IdP groups that grant the global admin role */
  adminGroups: string[]
  /** IdP group -> node group mapping ("idpGroup:nodeGroup,...", first match wins) */
  groupMap: { idpGroup: string; nodeGroup: string }[]
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
    groupClaim: process.env.HAPROXY_UI_OIDC_GROUP_CLAIM ?? "groups",
    adminGroups: (process.env.HAPROXY_UI_OIDC_ADMIN_GROUPS ?? "")
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean),
    groupMap: (process.env.HAPROXY_UI_OIDC_GROUP_MAP ?? "")
      .split(",")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const [idpGroup, nodeGroup] = pair.split(":").map((s) => s.trim())
        return { idpGroup, nodeGroup }
      })
      .filter((m) => m.idpGroup && m.nodeGroup),
  }
}

export function isOidcConfigured(): boolean {
  return readOidcEnv() !== null
}
