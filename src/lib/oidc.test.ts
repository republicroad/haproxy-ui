import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.HAPROXY_UI_DB = join(mkdtempSync(join(tmpdir(), "haproxy-ui-oidc-")), "test.db")
process.env.HAPROXY_UI_MAINTENANCE = "off"

type OidcModule = typeof import("./oidc")

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url")

function makeIdToken(keyPem: string, payload: Record<string, unknown>, kid = "key-1"): string {
  const header = { alg: "RS256", kid }
  const signed = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const sig = sign("RSA-SHA256", Buffer.from(signed), createPrivateKey(keyPem))
  return `${signed}.${b64url(sig)}`
}

const jwkOf = (keyPem: string, kid = "key-1") => {
  const jwk = createPublicKey(keyPem).export({ format: "jwk" }) as {
    kty: string
    n: string
    e: string
  }
  return { ...jwk, kid }
}

const cfg = {
  issuer: "https://idp.example.com",
  clientId: "haproxy-ui",
  clientSecret: "s3cret",
  adminEmails: ["ops@example.com"],
}

const discovery = {
  authorization_endpoint: "https://idp.example.com/authorize",
  token_endpoint: "https://idp.example.com/token",
  jwks_uri: "https://idp.example.com/jwks",
}

beforeEach(() => {
  delete process.env.HAPROXY_UI_OIDC_ISSUER
  delete process.env.HAPROXY_UI_OIDC_CLIENT_ID
  delete process.env.HAPROXY_UI_OIDC_CLIENT_SECRET
  delete process.env.HAPROXY_UI_OIDC_ADMIN_EMAILS
})

describe("readOidcEnv", () => {
  it("is null until issuer+client+secret are all set", async () => {
    const { readOidcEnv } = await import("./oidcEnv")
    expect(readOidcEnv()).toBeNull()
    process.env.HAPROXY_UI_OIDC_ISSUER = cfg.issuer
    process.env.HAPROXY_UI_OIDC_CLIENT_ID = cfg.clientId
    expect(readOidcEnv()).toBeNull()
    process.env.HAPROXY_UI_OIDC_CLIENT_SECRET = cfg.clientSecret
    const parsed = readOidcEnv()
    expect(parsed?.issuer).toBe(cfg.issuer)
    process.env.HAPROXY_UI_OIDC_ADMIN_EMAILS = "OPS@example.com, boss@example.com"
    expect(readOidcEnv()?.adminEmails).toEqual(["ops@example.com", "boss@example.com"])
  })
})

describe("buildAuthUrl", () => {
  it("carries client, scope, state and redirect", async () => {
    const { buildAuthUrl } = await import("./oidc")
    const url = new URL(buildAuthUrl(cfg, discovery, "st-123", "http://ui/callback"))
    expect(url.origin + url.pathname).toBe(discovery.authorization_endpoint)
    expect(url.searchParams.get("client_id")).toBe("haproxy-ui")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("state")).toBe("st-123")
    expect(url.searchParams.get("redirect_uri")).toBe("http://ui/callback")
    expect(url.searchParams.get("scope")).toContain("openid")
  })
})

describe("verifyIdToken", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const jwk = jwkOf(pem)

  it("accepts a properly signed, unexpired token for the right audience", async () => {
    const { verifyIdToken } = await import("./oidc")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })),
    )
    const token = makeIdToken(pem, {
      iss: cfg.issuer,
      aud: cfg.clientId,
      exp: Math.floor(Date.now() / 1000) + 300,
      email: "dev@example.com",
    })
    const claims = await verifyIdToken(cfg, discovery, token)
    expect(claims?.email).toBe("dev@example.com")
    vi.unstubAllGlobals()
  })

  it("rejects wrong issuer, wrong audience, expiry and bad signatures", async () => {
    const { verifyIdToken } = await import("./oidc")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })),
    )
    const base = {
      iss: cfg.issuer,
      aud: cfg.clientId,
      exp: Math.floor(Date.now() / 1000) + 300,
    }
    expect(
      await verifyIdToken(cfg, discovery, makeIdToken(pem, { ...base, iss: "https://evil" })),
    ).toBeNull()
    expect(
      await verifyIdToken(cfg, discovery, makeIdToken(pem, { ...base, aud: "other-client" })),
    ).toBeNull()
    expect(await verifyIdToken(cfg, discovery, makeIdToken(pem, { ...base, exp: 1 }))).toBeNull()
    // signed by a different key
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const otherPem = other.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    expect(await verifyIdToken(cfg, discovery, makeIdToken(otherPem, base))).toBeNull()
    // alg downgrade
    const forged = `eyJhbGciOiJub25lIn0.${b64url(JSON.stringify(base))}.`
    expect(await verifyIdToken(cfg, discovery, forged)).toBeNull()
    vi.unstubAllGlobals()
  })

  it("exchangeCode posts the authorization grant and returns the id_token", async () => {
    const { exchangeCode } = await import("./oidc")
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect(String(url)).toBe(discovery.token_endpoint)
        const body = new URLSearchParams(String(init?.body))
        expect(body.get("grant_type")).toBe("authorization_code")
        expect(body.get("code")).toBe("abc")
        expect(body.get("client_secret")).toBe("s3cret")
        return new Response(JSON.stringify({ id_token: "tok", access_token: "at" }), {
          status: 200,
        })
      }),
    )
    const tokens = await exchangeCode(cfg, discovery, "abc", "http://ui/callback")
    expect(tokens?.id_token).toBe("tok")
    vi.unstubAllGlobals()
  })
})

describe("provisionUser", () => {
  it("creates viewer by default and admin for configured emails", async () => {
    const oidc: OidcModule = await import("./oidc")
    const db = await import("#/lib/db")

    const v = oidc.provisionUser(cfg, { email: "dev@example.com" })
    expect(v).toBe("dev@example.com")
    const a = oidc.provisionUser(cfg, { email: "ops@example.com" })
    const roles = Object.fromEntries(db.listUsers().map((u) => [u.username, u.role]))
    expect(roles["dev@example.com"]).toBe("viewer")
    expect(roles["ops@example.com"]).toBe("admin")

    // existing admins are not demoted by later logins
    oidc.provisionUser(cfg, { email: "ops@example.com" })
    expect(db.listUsers().find((u) => u.username === a)?.role).toBe("admin")
  })
})
