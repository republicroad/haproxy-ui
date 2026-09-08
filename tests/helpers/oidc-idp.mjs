import { createServer } from "node:http"
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto"

/**
 * Minimal OIDC identity provider for browser E2E: discovery, JWKS,
 * auto-approving /authorize and a token endpoint issuing RS256 id_tokens
 * for a fixed test subject.
 */

const PORT = Number(process.env.OIDC_IDP_PORT ?? 4444)
const ISSUER = `http://127.0.0.1:${PORT}`
const CLIENT_ID = process.env.OIDC_IDP_CLIENT_ID ?? "haproxy-ui-e2e"
const EMAIL = process.env.OIDC_IDP_EMAIL ?? "admin@example.com"
const KID = "e2e-key-1"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" })
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: KID,
  alg: "RS256",
  use: "sig",
}

const b64url = (buf) => Buffer.from(buf).toString("base64url")

function idToken(aud, nonce) {
  const header = { alg: "RS256", kid: KID }
  const payload = {
    iss: ISSUER,
    aud,
    sub: "e2e-user",
    email: EMAIL,
    preferred_username: EMAIL,
    exp: Math.floor(Date.now() / 1000) + 600,
    ...(nonce ? { nonce } : {}),
  }
  const signed = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const sig = sign("RSA-SHA256", Buffer.from(signed), createPrivateKey(privatePem))
  return `${signed}.${b64url(sig)}`
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", ISSUER)
  if (url.pathname === "/.well-known/openid-configuration") {
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(
      JSON.stringify({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
      }),
    )
  }
  if (url.pathname === "/jwks") {
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify({ keys: [jwk] }))
  }
  if (url.pathname === "/authorize") {
    const target = new URL(url.searchParams.get("redirect_uri"))
    target.searchParams.set("code", "e2e-code")
    target.searchParams.set("state", url.searchParams.get("state") ?? "")
    return res.writeHead(302, { location: target.toString() }).end()
  }
  if (url.pathname === "/token" && req.method === "POST") {
    let body = ""
    req.on("data", (c) => (body += c))
    return req.on("end", () => {
      const form = new URLSearchParams(body)
      if (form.get("grant_type") !== "authorization_code" || form.get("code") !== "e2e-code") {
        res.writeHead(400, { "content-type": "application/json" })
        return res.end(JSON.stringify({ error: "invalid_grant" }))
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          access_token: "e2e-access",
          token_type: "Bearer",
          id_token: idToken(form.get("client_id") ?? CLIENT_ID, form.get("nonce") ?? undefined),
        }),
      )
    })
  }
  res.writeHead(404)
  res.end()
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[oidc-idp] stub issuer on ${ISSUER} (client=${CLIENT_ID}, email=${EMAIL})`)
})
