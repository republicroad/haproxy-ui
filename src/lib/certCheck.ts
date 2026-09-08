import { X509Certificate } from "node:crypto"
import { proxyToNode } from "#/lib/dataplane/proxy"

/**
 * Certificate inventory + expiry alerting helpers (server-side).
 * Shared by the certificates API route and the maintenance scheduler.
 */

export type CertMeta = {
  name: string
  subject: string | null
  issuer: string | null
  validTo: string | null
}

export function parsePemCert(pem: string):
  | { ok: true; info: { subject: string; issuer: string; validTo: string; validFrom: string } }
  | { ok: false; error: string } {
  try {
    const cert = new X509Certificate(pem)
    return {
      ok: true,
      info: {
        subject: cert.subject,
        issuer: cert.issuer,
        validTo: cert.validTo,
        validFrom: cert.validFrom,
      },
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

async function dp(nodeId: string, path: string): Promise<Response> {
  return proxyToNode(
    nodeId,
    new Request("http://internal/certs", { method: "GET" }),
    path,
  )
}

/** List all stored certificates with parsed X.509 metadata. */
export async function listCertsWithExpiry(nodeId: string): Promise<CertMeta[]> {
  const res = await dp(nodeId, "services/haproxy/storage/ssl")
  const text = await res.text()
  let list: { storage_name?: string; id?: string; description?: string }[] = []
  try {
    const parsed = JSON.parse(text) as unknown
    list = Array.isArray(parsed)
      ? parsed
      : ((parsed as { data?: typeof list }).data ?? [])
  } catch {
    return []
  }
  const certs = await Promise.all(
    list.map(async (c) => {
      const name = c.storage_name ?? c.id ?? "?"
      const pemRes = await dp(
        nodeId,
        `services/haproxy/storage/ssl/${encodeURIComponent(name)}`,
      ).catch(() => null)
      const pem = pemRes && pemRes.ok ? await pemRes.text() : ""
      const parsed = pem.includes("BEGIN CERTIFICATE") ? parsePemCert(pem) : null
      return {
        name,
        subject: parsed?.ok ? parsed.info.subject : null,
        issuer: parsed?.ok ? parsed.info.issuer : null,
        validTo: parsed?.ok ? parsed.info.validTo : null,
      }
    }),
  )
  return certs
}

export type ExpiringCert = CertMeta & { daysLeft: number; expired: boolean }

/**
 * Pure selection logic: which certificates should raise (or repeat) an
 * expiry alert. Expired certs and certs within `warnDays` qualify.
 */
export function expiringCerts(certs: CertMeta[], warnDays: number): ExpiringCert[] {
  const out: ExpiringCert[] = []
  for (const c of certs) {
    if (!c.validTo) continue
    const ms = new Date(c.validTo).getTime() - Date.now()
    const daysLeft = Math.floor(ms / 86_400_000)
    const expired = ms < 0
    if (expired || daysLeft <= warnDays) {
      out.push({ ...c, daysLeft, expired })
    }
  }
  return out
}
