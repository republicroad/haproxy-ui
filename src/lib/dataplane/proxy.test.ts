import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

async function loadProxyWithNode(node: {
  id: string
  apiUrl: string
  apiUser: string
  apiPass: string
}) {
  vi.resetModules()
  vi.doMock("#/lib/db", () => ({
    getNode: (id: string) => (id === node.id ? node : undefined),
  }))
  return import("./proxy")
}

function startUpstream(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
): Promise<Server> {
  return new Promise((resolve) => {
    const s = createServer(handler)
    s.listen(0, "127.0.0.1", () => resolve(s))
  })
}

let servers: Server[] = []
afterEach(() => {
  for (const s of servers) s.close()
  servers = []
  vi.restoreAllMocks()
})

const req = (path: string, method = "GET", body?: string) =>
  new Request(`http://app.local${path}`, {
    method,
    body,
    headers: body ? { "content-type": "application/json" } : undefined,
  })

describe("proxyToNode", () => {
  const nodeId = "n1"

  it("returns 404 for unknown node", async () => {
    const { proxyToNode } = await loadProxyWithNode({
      id: nodeId,
      apiUrl: "http://ignored",
      apiUser: "u",
      apiPass: "p",
    })
    const res = await proxyToNode("missing", req("/api/dp/missing/services"))
    expect(res.status).toBe(404)
  })

  it("forwards path under /v3/ with injected basic auth", async () => {
    let seenAuth = ""
    let seenPath = ""
    const s = await startUpstream((rq, rs) => {
      seenAuth = rq.headers.authorization ?? ""
      seenPath = rq.url ?? ""
      rs.setHeader("content-type", "application/json")
      rs.end(JSON.stringify({ ok: true }))
    })
    servers.push(s)
    const port = (s.address() as AddressInfo).port
    const { proxyToNode } = await loadProxyWithNode({
      id: nodeId,
      apiUrl: `http://127.0.0.1:${port}`,
      apiUser: "adm",
      apiPass: "sec",
    })

    const res = await proxyToNode(
      nodeId,
      req(`/api/dp/${nodeId}/services/haproxy/configuration/frontends`),
    )
    expect(res.status).toBe(200)
    expect(seenPath).toBe("/v3/services/haproxy/configuration/frontends")
    expect(seenAuth).toBe(`Basic ${Buffer.from("adm:sec").toString("base64")}`)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("preserves query string and strips trailing slashes", async () => {
    let seenPath = ""
    const s = await startUpstream((rq, rs) => {
      seenPath = rq.url ?? ""
      rs.end("x")
    })
    servers.push(s)
    const port = (s.address() as AddressInfo).port
    const { proxyToNode } = await loadProxyWithNode({
      id: nodeId,
      apiUrl: `http://127.0.0.1:${port}`,
      apiUser: "u",
      apiPass: "p",
    })

    await proxyToNode(
      nodeId,
      req(`/api/dp/${nodeId}/services/haproxy/configuration/backends?transaction_id=t1`),
    )
    expect(seenPath).toBe(
      "/v3/services/haproxy/configuration/backends?transaction_id=t1",
    )
  })

  it("supports splatOverride and forwards POST bodies", async () => {
    let seenBody = ""
    let seenMethod = ""
    let seenCt = ""
    const s = await startUpstream((rq, rs) => {
      seenMethod = rq.method ?? ""
      seenCt = rq.headers["content-type"] ?? ""
      let data = ""
      rq.on("data", (c) => (data += c))
      rq.on("end", () => {
        seenBody = data
        rs.end("created")
      })
    })
    servers.push(s)
    const port = (s.address() as AddressInfo).port
    const { proxyToNode } = await loadProxyWithNode({
      id: nodeId,
      apiUrl: `http://127.0.0.1:${port}`,
      apiUser: "u",
      apiPass: "p",
    })

    const res = await proxyToNode(
      nodeId,
      req(`/api/dp/${nodeId}/anything`, "POST", JSON.stringify({ name: "be1" })),
      "services/haproxy/configuration/backends",
    )
    expect(seenMethod).toBe("POST")
    expect(seenCt).toBe("application/json")
    expect(seenBody).toBe(JSON.stringify({ name: "be1" }))
    expect(await res.text()).toBe("created")
  })

  it("does not send a body for GET/DELETE", async () => {
    const s = await startUpstream((_rq, rs) => rs.end("ok"))
    servers.push(s)
    const port = (s.address() as AddressInfo).port
    const { proxyToNode } = await loadProxyWithNode({
      id: nodeId,
      apiUrl: `http://127.0.0.1:${port}`,
      apiUser: "u",
      apiPass: "p",
    })
    const res = await proxyToNode(
      nodeId,
      req(`/api/dp/${nodeId}/x`, "DELETE"),
      "services/haproxy/transactions/tx1",
    )
    expect(res.status).toBe(200)
  })

  it("returns 502 when upstream is unreachable", async () => {
    const { proxyToNode } = await loadProxyWithNode({
      id: nodeId,
      apiUrl: "http://127.0.0.1:1",
      apiUser: "u",
      apiPass: "p",
    })
    const res = await proxyToNode(nodeId, req(`/api/dp/${nodeId}/services`))
    expect(res.status).toBe(502)
    const j = (await res.json()) as { error: string }
    expect(j.error).toContain("cannot reach dataplaneapi")
  })

  it("forwards upstream status codes (409 conflict etc.)", async () => {
    const s = await startUpstream((_rq, rs) => {
      rs.statusCode = 409
      rs.end(JSON.stringify({ error: "conflict" }))
    })
    servers.push(s)
    const port = (s.address() as AddressInfo).port
    const { proxyToNode } = await loadProxyWithNode({
      id: nodeId,
      apiUrl: `http://127.0.0.1:${port}`,
      apiUser: "u",
      apiPass: "p",
    })
    const res = await proxyToNode(nodeId, req(`/api/dp/${nodeId}/x`))
    expect(res.status).toBe(409)
  })
})
