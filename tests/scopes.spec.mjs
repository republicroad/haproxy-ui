import { expect, test } from "@playwright/test"

/**
 * Identity scopes end-to-end: readonly API tokens and group admins,
 * verified against the running dev server (auth user e2e/e2epass).
 */
test.describe.serial("identity scopes", () => {
  let edgeNodeId
  let coreNodeId
  let readonlyToken

  async function adminHeaders(request) {
    const res = await request.post("/api/auth/login", {
      data: { user: "e2e", pass: "e2epass" },
    })
    expect(res.ok()).toBeTruthy()
    const cookie = res
      .headersArray()
      .find((h) => h.name.toLowerCase() === "set-cookie")
      ?.value.split(";")[0]
    expect(cookie).toBeTruthy()
    return { cookie }
  }

  test("setup: register grouped nodes, a group admin and a readonly token", async ({ request }) => {
    const auth = await adminHeaders(request)
    const cookieHeader = auth.cookie

    for (const [name, group] of [
      ["edge-node", "edge"],
      ["core-node", "core"],
    ]) {
      const res = await request.post("/api/nodes", {
        headers: { cookie: cookieHeader },
        data: { name, apiUrl: "http://localhost:9090", group },
      })
      expect(res.ok()).toBeTruthy()
      const j = await res.json()
      if (group === "edge") edgeNodeId = j.id
      else coreNodeId = j.id
    }

    const userRes = await request.post("/api/users", {
      headers: { cookie: cookieHeader },
      data: {
        username: "grp-admin",
        password: "grppass123",
        role: "admin",
        group: "edge",
      },
    })
    expect(userRes.ok()).toBeTruthy()

    const tokRes = await request.post("/api/tokens", {
      headers: { cookie: cookieHeader },
      data: { name: "e2e-readonly", role: "admin", scopeKind: "readonly" },
    })
    expect(tokRes.ok()).toBeTruthy()
    readonlyToken = (await tokRes.json()).token
    expect(readonlyToken).toMatch(/^hui_/)
  })

  test("readonly token can read but never write", async ({ request }) => {
    const bearer = { authorization: `Bearer ${readonlyToken}` }
    const read = await request.get("/api/nodes", { headers: bearer })
    expect(read.status()).toBe(200)

    const write = await request.post("/api/nodes", {
      headers: bearer,
      data: { name: "nope", apiUrl: "http://localhost:9090" },
    })
    expect(write.status()).toBe(403)
    expect((await write.json()).error).toContain("read-only")
  })

  test("group admin is scoped to their group", async ({ request }) => {
    const res = await request.post("/api/auth/login", {
      data: { user: "grp-admin", pass: "grppass123" },
    })
    expect(res.ok()).toBeTruthy()
    const cookie = res
      .headersArray()
      .find((h) => h.name.toLowerCase() === "set-cookie")
      ?.value.split(";")[0]

    // node list is filtered to the group
    const list = await request.get("/api/nodes", { headers: { cookie } })
    const nodes = await list.json()
    expect(nodes.map((n) => n.name).sort()).toEqual(["edge-node"])

    // in-group dataplane reads pass, other groups are denied
    const ok = await request.get(`/api/dp/${edgeNodeId}/services/haproxy/runtime/info`, {
      headers: { cookie },
    })
    expect(ok.status()).toBe(200)
    const denied = await request.get(`/api/dp/${coreNodeId}/services/haproxy/runtime/info`, {
      headers: { cookie },
    })
    expect(denied.status()).toBe(403)
    expect((await denied.json()).error).toContain("outside your node group")
  })

  test("group admin sees only their group's nodes in the UI", async ({ browser, request }) => {
    const res = await request.post("/api/auth/login", {
      data: { user: "grp-admin", pass: "grppass123" },
    })
    const cookie = res
      .headersArray()
      .find((h) => h.name.toLowerCase() === "set-cookie")
      ?.value.split(";")[0]

    const context = await browser.newContext()
    const [name, value] = cookie.split("=")
    await context.addCookies([{ name, value, url: "http://localhost:3999" }])
    const page = await context.newPage()
    await page.goto("/nodes")
    await expect(page.getByText("edge-node").first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("core-node")).toHaveCount(0)
    await context.close()
  })
})
