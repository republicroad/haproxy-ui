import { createFileRoute } from "@tanstack/react-router"
import { proxyToNode } from "#/lib/dataplane/proxy"
import { parsePemCert } from "#/lib/certCheck"

async function dp(
  nodeId: string,
  method: string,
  path: string,
  body?: string,
  contentType?: string,
): Promise<Response> {
  const req = new Request("http://internal/certs", {
    method,
    headers: contentType ? { "content-type": contentType } : undefined,
    body: body === undefined ? undefined : body,
  })
  return proxyToNode(nodeId, req, path)
}

type StoredCert = { id?: string; storage_name?: string; description?: string }

export const Route = createFileRoute("/api/nodes/$id/certs")({
  server: {
    handlers: {
      /** List certificates with parsed X.509 metadata (expiry tracking). */
      GET: async ({ params }) => {
        const res = await dp(params.id, "GET", "services/haproxy/storage/ssl")
        const text = await res.text()
        let list: StoredCert[] = []
        try {
          const parsed = JSON.parse(text) as unknown
          list = Array.isArray(parsed) ? parsed : ((parsed as { data?: StoredCert[] }).data ?? [])
        } catch {
          return Response.json({ error: "cannot reach dataplaneapi" }, { status: 502 })
        }
        const certs = await Promise.all(
          list.map(async (c) => {
            const name = c.storage_name ?? c.id ?? "?"
            const pemRes = await dp(
              params.id,
              "GET",
              `services/haproxy/storage/ssl/${encodeURIComponent(name)}`,
            ).catch(() => null)
            const pem = pemRes && pemRes.ok ? await pemRes.text() : ""
            const parsed = pem.includes("BEGIN CERTIFICATE") ? parsePemCert(pem) : null
            return {
              name,
              description: c.description ?? "",
              subject: parsed?.ok ? parsed.info.subject : null,
              issuer: parsed?.ok ? parsed.info.issuer : null,
              validFrom: parsed?.ok ? parsed.info.validFrom : null,
              validTo: parsed?.ok ? parsed.info.validTo : null,
            }
          }),
        )
        return Response.json({ certs })
      },
      /** Upload a PEM certificate ({ name, pem }). */
      POST: async ({ params, request }) => {
        let body: { name?: string; pem?: string }
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 })
        }
        const name = (body.name ?? "").trim()
        const pem = body.pem ?? ""
        if (!name || !pem) {
          return Response.json({ error: "name and pem are required" }, { status: 400 })
        }
        if (!pem.includes("BEGIN CERTIFICATE")) {
          return Response.json({ error: "pem must contain a CERTIFICATE block" }, { status: 400 })
        }
        const parsed = parsePemCert(pem)
        if (!parsed.ok) {
          return Response.json({ error: `invalid certificate: ${parsed.error}` }, { status: 400 })
        }
        const upstream = await dp(
          params.id,
          "POST",
          `services/haproxy/storage/ssl?name=${encodeURIComponent(name)}`,
          pem,
          "text/plain",
        )
        if (upstream.status === 409) {
          return Response.json({ error: "certificate already exists" }, { status: 409 })
        }
        if (!upstream.ok && upstream.status !== 202 && upstream.status !== 201) {
          return Response.json(
            { error: `upload failed: ${await upstream.text()}` },
            { status: 502 },
          )
        }
        return Response.json({ ok: true, name, validTo: parsed.info.validTo }, { status: 201 })
      },
      /** Delete a stored certificate. */
      DELETE: async ({ params, request }) => {
        const url = new URL(request.url)
        const name = url.searchParams.get("name")
        if (!name) {
          return Response.json({ error: "?name= required" }, { status: 400 })
        }
        const upstream = await dp(
          params.id,
          "DELETE",
          `services/haproxy/storage/ssl/${encodeURIComponent(name)}`,
        )
        if (!upstream.ok && upstream.status !== 202) {
          return Response.json(
            { error: `delete failed: ${await upstream.text()}` },
            { status: 502 },
          )
        }
        return Response.json({ ok: true })
      },
    },
  },
})
