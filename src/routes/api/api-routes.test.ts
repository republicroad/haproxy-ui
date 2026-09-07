import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, type Server } from "node:http"

process.env.HAPROXY_UI_DB = join(mkdtempSync(join(tmpdir(), "haproxy-ui-routes-")), "test.db")

type DbModule = typeof import("#/lib/db")
type AuthModule = typeof import("#/lib/auth")

let db: DbModule
let auth: AuthModule

beforeEach(async () => {
  // single shared module graph per file; fresh DB per file run
  if (!db) {
    db = await import("#/lib/db")
    auth = await import("#/lib/auth")
  }
})

const nodeRow = (id: string, apiUrl: string) => ({
  id,
  name: `node-${id}`,
  apiUrl,
  apiUser: "admin",
  apiPass: "admin",
  haproxyVersion: null,
  status: "unknown",
  lastSeen: null,
  createdAt: 1_000,
  group: null,
})

function jsonRequest(
  url: string,
  method: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  return new Request(url, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>
}

// ---------- changes route ----------

describe("POST /api/nodes/$id/changes", () => {
  it("rejects invalid JSON with 400", async () => {
    const { Route } = (await import("./nodes/$id/changes")) as unknown as {
      Route: { options: { server: { handlers: Record<string, CallableFunction> } } }
    }
    const req = new Request("http://x/api/nodes/n1/changes", {
      method: "POST",
      body: "not json",
    })
    const res = (await Route.options.server.handlers.POST({
      params: { id: "n1" },
      request: req,
    })) as Response
    expect(res.status).toBe(400)
  })

  it("validates the change meta and reports field errors", async () => {
    const { Route } = (await import("./nodes/$id/changes")) as unknown as {
      Route: { options: { server: { handlers: Record<string, CallableFunction> } } }
    }
    const res = (await Route.options.server.handlers.POST({
      params: { id: "n1" },
      request: jsonRequest("http://x/api/nodes/n1/changes", "POST", {
        kind: "bogus",
        target: "",
      }),
    })) as Response
    expect(res.status).toBe(400)
    const body = await jsonOf(res)
    expect(body.error).toBe("validation failed")
    expect(body.fields).toBeTruthy()
  })

  it("records a change and lists it; cleanup requires params", async () => {
    const { Route } = (await import("./nodes/$id/changes")) as unknown as {
      Route: { options: { server: { handlers: Record<string, CallableFunction> } } }
    }
    const post = (await Route.options.server.handlers.POST({
      params: { id: "n-changes" },
      request: jsonRequest("http://x/api/nodes/n-changes/changes", "POST", {
        kind: "create",
        resource: "backend",
        target: "be_route",
        payload: { name: "be_route" },
      }),
    })) as Response
    expect(post.status).toBe(201)

    const get = (await Route.options.server.handlers.GET({
      params: { id: "n-changes" },
      request: new Request("http://x/api/nodes/n-changes/changes"),
    })) as Response
    const body = (await get.json()) as {
      changes: { target: string; actor: string | null }[]
      total: number
    }
    expect(body.total).toBe(1)
    expect(body.changes[0].target).toBe("be_route")
    // auth is off in this suite: actor stays null
    expect(body.changes[0].actor).toBeNull()

    const del = (await Route.options.server.handlers.DELETE({
      params: { id: "n-changes" },
      request: new Request("http://x/api/nodes/n-changes/changes"),
    })) as Response
    expect(del.status).toBe(400)

    const delLimit = (await Route.options.server.handlers.DELETE({
      params: { id: "n-changes" },
      request: new Request("http://x/api/nodes/n-changes/changes?limit=1"),
    })) as Response
    expect(delLimit.status).toBe(200)
  })
})

// ---------- revert route ----------

describe("POST /api/nodes/$id/changes/$changeId/revert", () => {
  let dpServer: Server
  let dpUrl: string

  beforeAll(async () => {
    dpServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost")
      const p = url.pathname.replace(/^\/v3\//, "")
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(body))
      }
      if (p === "services/haproxy/configuration/version" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/plain" })
        return res.end("1")
      }
      if (p === "services/haproxy/transactions" && req.method === "POST") {
        return reply(201, { id: "tx_test_1", status: "pending" })
      }
      if (p === "services/haproxy/transactions/tx_test_1" && req.method === "PUT") {
        return reply(200, { id: "tx_test_1", status: "success" })
      }
      if (p === "services/haproxy/transactions/tx_test_1" && req.method === "DELETE") {
        return reply(200, { id: "tx_test_1", status: "cancelled" })
      }
      if (
        p.startsWith("services/haproxy/configuration/backends/") &&
        req.method === "DELETE"
      ) {
        return reply(202, {})
      }
      if (
        (p === "services/haproxy/configuration/backends" ||
          p.startsWith("services/haproxy/configuration/backends/")) &&
        req.method === "POST"
      ) {
        return reply(201, { name: "be_restored" })
      }
      if (p === "services/haproxy/configuration/raw" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/plain" })
        return res.end("backend be_restored\n")
      }
      return reply(404, { message: `no handler for ${req.method} ${p}` })
    })
    await new Promise<void>((resolve) => dpServer.listen(0, "127.0.0.1", resolve))
    const addr = dpServer.address() as { port: number }
    dpUrl = `http://127.0.0.1:${addr.port}`
    db.insertNode(nodeRow("n-revert", dpUrl))
  })

  afterAll(() => {
    dpServer.close()
  })

  async function seedChange(kind: "create" | "delete", target: string) {
    const id = crypto.randomUUID()
    db.insertChange({
      id,
      nodeId: "n-revert",
      ts: Date.now(),
      kind,
      resource: "backend",
      target,
      parent: null,
      payload: kind === "delete" ? JSON.stringify({ name: target }) : null,
      txId: null,
      reverted: 0,
      rawAfter: null,
      actor: null,
    })
    return id
  }

  it("404s for unknown change ids and nodes", async () => {
    const { Route } = (await import("./nodes/$id/changes/$changeId/revert")) as unknown as {
      Route: { options: { server: { handlers: Record<string, CallableFunction> } } }
    }
    const missing = (await Route.options.server.handlers.POST({
      params: { id: "n-revert", changeId: "nope" },
      request: new Request("http://x/revert", { method: "POST" }),
    })) as Response
    expect(missing.status).toBe(404)

    const wrongNode = (await Route.options.server.handlers.POST({
      params: { id: "other-node", changeId: "also-nope" },
      request: new Request("http://x/revert", { method: "POST" }),
    })) as Response
    expect(wrongNode.status).toBe(404)
  })

  it("rejects reverting an update entry", async () => {
    const { Route } = (await import("./nodes/$id/changes/$changeId/revert")) as unknown as {
      Route: { options: { server: { handlers: Record<string, CallableFunction> } } }
    }
    const id = crypto.randomUUID()
    db.insertChange({
      id,
      nodeId: "n-revert",
      ts: Date.now(),
      kind: "update",
      resource: "backend",
      target: "be_upd",
      parent: null,
      payload: null,
      txId: null,
      reverted: 0,
      rawAfter: null,
      actor: null,
    })
    const res = (await Route.options.server.handlers.POST({
      params: { id: "n-revert", changeId: id },
      request: new Request("http://x/revert", { method: "POST" }),
    })) as Response
    expect(res.status).toBe(400)
  })

  it("reverts a create (deletes the object) and marks the record; double revert 409s", async () => {
    const { Route } = (await import("./nodes/$id/changes/$changeId/revert")) as unknown as {
      Route: { options: { server: { handlers: Record<string, CallableFunction> } } }
    }
    const id = await seedChange("create", "be_gone")
    const res = (await Route.options.server.handlers.POST({
      params: { id: "n-revert", changeId: id },
      request: new Request("http://x/revert", { method: "POST" }),
    })) as Response
    expect(res.status).toBe(200)
    const body = await jsonOf(res)
    expect(body.ok).toBe(true)
    expect(db.getChange(id)?.reverted).toBe(1)

    const again = (await Route.options.server.handlers.POST({
      params: { id: "n-revert", changeId: id },
      request: new Request("http://x/revert", { method: "POST" }),
    })) as Response
    expect(again.status).toBe(409)
  })

  it("reverts a delete by re-creating the object from the recorded payload", async () => {
    const { Route } = (await import("./nodes/$id/changes/$changeId/revert")) as unknown as {
      Route: { options: { server: { handlers: Record<string, CallableFunction> } } }
    }
    const id = await seedChange("delete", "be_restored")
    const res = (await Route.options.server.handlers.POST({
      params: { id: "n-revert", changeId: id },
      request: new Request("http://x/revert", { method: "POST" }),
    })) as Response
    expect(res.status).toBe(200)
    expect(db.getChange(id)?.reverted).toBe(1)
  })
})

// ---------- tokens route (admin-only + hash hygiene) ----------

describe("/api/tokens route", () => {
  it("mints a token once and never exposes hashes", async () => {
    const { Route } = (await import("./tokens")) as unknown as {
      Route: { options: { server: { handlers: Record<string, CallableFunction> } } }
    }
    const mint = (await Route.options.server.handlers.POST({
      request: jsonRequest("http://x/api/tokens", "POST", {
        name: "ci-runner",
        role: "viewer",
      }),
    })) as Response
    expect(mint.status).toBe(201)
    const body = await jsonOf(mint)
    expect(String(body.token)).toMatch(/^hui_/)

    const list = (await Route.options.server.handlers.GET({
      request: new Request("http://x/api/tokens"),
    })) as Response
    const tokens = (await list.json()) as { tokenHash?: string; token?: string }[]
    expect(tokens.length).toBeGreaterThan(0)
    for (const t of tokens) {
      expect(t.tokenHash).toBeUndefined()
      expect(t.token).toBeUndefined()
    }
  })

  it("validates the mint body", async () => {
    const { Route } = (await import("./tokens")) as unknown as {
      Route: { options: { server: { handlers: Record<string, CallableFunction> } } }
    }
    const bad = (await Route.options.server.handlers.POST({
      request: jsonRequest("http://x/api/tokens", "POST", { name: "x", role: "root" }),
    })) as Response
    expect(bad.status).toBe(400)
  })
})

// ---------- auth + RBAC matrix (lib + global middleware) ----------

describe("auth + RBAC matrix", () => {
  it("classifies cross-site writes", () => {
    const same = new Request("http://ui.local/api/nodes", {
      method: "POST",
      headers: { origin: "http://ui.local" },
    })
    const foreign = new Request("http://ui.local/api/nodes", {
      method: "POST",
      headers: { origin: "http://evil.example" },
    })
    const curlLike = new Request("http://ui.local/api/nodes", { method: "POST" })
    const crossGet = new Request("http://ui.local/api/nodes", {
      method: "GET",
      headers: { origin: "http://evil.example" },
    })
    expect(auth.isCrossSiteWrite(same)).toBe(false)
    expect(auth.isCrossSiteWrite(foreign)).toBe(true)
    expect(auth.isCrossSiteWrite(curlLike)).toBe(false)
    expect(auth.isCrossSiteWrite(crossGet)).toBe(false)
  })

  it("is admin-only when auth is disabled", () => {
    expect(auth.authEnabled()).toBe(false)
    expect(auth.roleFromRequest(new Request("http://x/api/nodes"))).toBe("admin")
    expect(auth.actorFromRequest(new Request("http://x/api/nodes"))).toBeNull()
  })

  describe("with env auth enabled", () => {
    beforeEach(() => {
      process.env.HAPROXY_UI_USER = "boss"
      process.env.HAPROXY_UI_PASS = "secret123"
    })

    it("session tokens resolve to their DB role", () => {
      db.insertUser({
        username: "viewer1",
        passHash: auth.hashPassword("pw123456"),
        role: "viewer",
      })
      const adminToken = auth.createSessionToken("boss")
      const viewerToken = auth.createSessionToken("viewer1")
      const cookie = (t: string) => ({ cookie: `hui_session=${t}` })

      expect(
        auth.roleFromRequest(
          new Request("http://x/api/nodes", { headers: cookie(adminToken) }),
        ),
      ).toBe("admin")
      expect(
        auth.roleFromRequest(
          new Request("http://x/api/nodes", { headers: cookie(viewerToken) }),
        ),
      ).toBe("viewer")
      expect(
        auth.actorFromRequest(
          new Request("http://x/api/nodes", { headers: cookie(viewerToken) }),
        ),
      ).toBe("viewer1")
    })

    it("bearer API tokens authenticate and carry their role", async () => {
      const minted = auth.mintApiToken("rbac-probe", "viewer")
      const req = new Request("http://x/api/nodes", {
        headers: { authorization: `Bearer ${minted.token}` },
      })
      expect(auth.identityFromRequest(req)?.role).toBe("viewer")
      expect(auth.actorFromRequest(req)).toBe("token:rbac-probe")
    })

    it("rejects tampered and unknown session tokens", () => {
      const token = auth.createSessionToken("boss")
      expect(auth.verifySessionToken(token + "x")).toBeNull()
      expect(auth.verifySessionToken("garbage")).toBeNull()
      expect(
        auth.verifySessionToken(`${token.split(".")[0]}.deadbeef`),
      ).toBeNull()
      const anonymous = new Request("http://x/api/nodes")
      expect(auth.identityFromRequest(anonymous)).toBeNull()
      expect(auth.roleFromRequest(anonymous)).toBeNull()
    })

    it("middleware blocks viewer writes and anonymous API calls", async () => {
      const mw = (await import("#/middleware")) as unknown as {
        authMiddleware: { options: { server: CallableFunction } }
      }
      const viewerToken = auth.createSessionToken("viewer1")
      const adminToken = auth.createSessionToken("boss")
      const cookie = (t: string) => ({ cookie: `hui_session=${t}` })
      const okNext = new Response("{}", { status: 200 })
      const call = (req: Request) =>
        mw.authMiddleware.options.server({
          request: req,
          pathname: new URL(req.url).pathname,
          context: {},
          next: async () => okNext,
          handlerType: "router",
        })
      const statusOf = async (req: Request) => {
        const out = (await call(req)) as Response | { response: Response }
        const res = out instanceof Response ? out : out.response
        return res.status
      }

      const base = "http://ui.local"
      // anonymous API → 401, anonymous page → redirect to /login
      expect(
        await statusOf(new Request(`${base}/api/nodes`)),
      ).toBe(401)
      const pageRes = (await call(new Request(`${base}/nodes`))) as Response
      expect(pageRes.status).toBe(302)
      expect(pageRes.headers.get("location")).toContain("/login")

      // viewer: read ok, write 403
      expect(
        await statusOf(
          new Request(`${base}/api/nodes`, { headers: cookie(viewerToken) }),
        ),
      ).toBe(200)
      expect(
        await statusOf(
          new Request(`${base}/api/nodes`, {
            method: "POST",
            headers: cookie(viewerToken),
          }),
        ),
      ).toBe(403)

      // admin: write ok
      expect(
        await statusOf(
          new Request(`${base}/api/nodes`, {
            method: "POST",
            headers: cookie(adminToken),
          }),
        ),
      ).toBe(200)

      // login + auth status stay public
      expect(
        await statusOf(new Request(`${base}/api/auth/status`)),
      ).toBe(200)
    })

    it("rate-limits login attempts after 5 failures", () => {
      const ip = "203.0.113.7"
      expect(auth.loginAllowed(ip)).toBe(true)
      for (let i = 0; i < 5; i++) auth.recordLoginFailure(ip)
      expect(auth.loginAllowed(ip)).toBe(false)
    })
  })
})
