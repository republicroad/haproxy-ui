import { getNode } from "#/lib/db"

/**
 * Proxy an incoming request to a node's dataplaneapi, injecting basic-auth
 * server-side so the browser never sees node credentials.
 *
 * The trailing path after /api/dp/:nodeId/ is forwarded as the dataplaneapi
 * path (e.g. services/haproxy/configuration/frontends).
 */
export async function proxyToNode(
  nodeId: string,
  request: Request,
  splatOverride?: string,
): Promise<Response> {
  const node = getNode(nodeId)
  if (!node) {
    return Response.json({ error: "node not found" }, { status: 404 })
  }
  const url = new URL(request.url)
  const splat = (splatOverride ?? url.pathname.replace(/^\/api\/dp\/[^/]+/, ""))
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")

  const target = `${node.apiUrl.replace(/\/+$/, "")}/v3/${splat}${url.search}`
  const auth =
    "Basic " +
    Buffer.from(`${node.apiUser}:${node.apiPass}`).toString("base64")

  const headers = new Headers()
  headers.set("Authorization", auth)
  const contentType = request.headers.get("content-type")
  if (contentType) headers.set("content-type", contentType)

  let body: BodyInit | undefined
  if (request.method !== "GET" && request.method !== "DELETE") {
    body = await request.text()
  }

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
    })
    const text = await upstream.text()
    return new Response(text, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      },
    })
  } catch (e) {
    return Response.json(
      { error: `cannot reach dataplaneapi: ${(e as Error).message}` },
      { status: 502 },
    )
  }
}
