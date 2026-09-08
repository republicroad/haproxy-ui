import { expect, test } from "@playwright/test"

let nodeId

/**
 * Click and retry until `verify` passes — covers hydration races where
 * the first click lands before React attaches event handlers.
 */
async function clickUntil(page, locator, verify) {
  for (let i = 0; i < 6; i++) {
    await locator.click()
    try {
      await verify({ timeout: 1500 })
      return
    } catch {
      // not effective yet — click again
    }
  }
  await verify()
}

/**
 * Click a tab and wait until it is actually selected.
 */
async function goTab(page, name) {
  const tab = page.getByRole("tab", { name: new RegExp(name) })
  await clickUntil(page, tab, (opts) =>
    expect(tab).toHaveAttribute("aria-selected", "true", opts),
  )
}

test.describe.serial("haproxy-ui e2e", () => {
  test("overview shows fleet health and stats cards", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Fleet health" })).toBeVisible()
    await expect(page.getByText("No nodes registered yet")).toBeVisible()
  })

  test("nodes page renders import/export/compare buttons", async ({ page }) => {
    await page.goto("/nodes")
    await expect(page.getByRole("heading", { name: "Nodes" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Export nodes" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Import nodes" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Compare" })).toBeDisabled()
    await expect(page.getByRole("button", { name: "Register node" })).toBeVisible()
  })

  test("register a node via the form dialog", async ({ page }) => {
    await page.goto("/nodes")
    await clickUntil(
      page,
      page.getByRole("button", { name: "Register node" }),
      (opts) =>
        expect(page.getByPlaceholder("edge-1")).toBeVisible(opts),
    )
    await page.getByPlaceholder("edge-1").fill("e2e-node")
    await page.getByPlaceholder("http://localhost:5555").fill("http://localhost:9090")
    await page.getByRole("button", { name: "Register", exact: true }).last().click()
    await expect(page.getByText("Node registered")).toBeVisible()
    const link = page.getByRole("link", { name: "e2e-node" })
    await expect(link).toBeVisible()
    nodeId = await link.getAttribute("href").then((h) => h?.split("/").pop())
  })

  test("node detail renders all tabs", async ({ page }) => {
    test.skip(!nodeId, "node not created")
    await page.goto(`/nodes/${nodeId}`)
    for (const tab of ["overview", "frontends", "backends", "traffic", "acls", "rules", "waf", "logs", "stats", "stick", "history", "raw"]) {
      await expect(page.getByText(tab, { exact: true })).toBeVisible()
    }
    await expect(page.getByRole("button", { name: "Sync to nodes" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Export config" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Import config" })).toBeVisible()
  })

  test("create a frontend through the dialog", async ({ page }) => {
    test.skip(!nodeId, "node not created")
    await page.goto(`/nodes/${nodeId}`)
    await goTab(page, "frontends")
    await page.getByRole("button", { name: "New frontend" }).click()
    await page.getByPlaceholder("name").fill("fe_e2e")
    await page.getByPlaceholder("bind address").fill("*")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByText('Frontend "fe_e2e" created')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole("cell", { name: "fe_e2e" }).first()).toBeVisible()
  })

  test("delete the frontend and see history", async ({ page }) => {
    test.skip(!nodeId, "node not created")
    await page.goto(`/nodes/${nodeId}`)
    await goTab(page, "frontends")
    await page.getByRole("button", { name: "Delete" }).first().click()
    await expect(page.getByText('Frontend "fe_e2e" deleted')).toBeVisible({ timeout: 15_000 })
    await goTab(page, "history")
    await expect(page.getByText("fe_e2e").first()).toBeVisible()
  })

  test("stats tab shows runtime servers with admin state buttons", async ({ page }) => {
    test.skip(!nodeId, "node not created")
    await page.goto(`/nodes/${nodeId}`)
    await goTab(page, "backends")
    const hasBe = await page.getByRole("cell", { name: "be_e2e" }).first().isVisible().catch(() => false)
    if (!hasBe) {
      await page.getByRole("button", { name: "New backend" }).click()
      await page.getByPlaceholder("name").fill("be_e2e")
      await page.getByRole("button", { name: "Create" }).click()
      await expect(page.getByText('Backend "be_e2e" created')).toBeVisible({ timeout: 15_000 })
      await page.getByRole("button", { name: "Servers" }).first().click()
      await page.getByPlaceholder("server name").fill("srv_e2e")
      await page.getByPlaceholder("address").fill("10.10.10.10")
      await page.getByRole("button", { name: "Add server" }).click()
      await expect(page.getByText("srv_e2e").first()).toBeVisible()
      await page.keyboard.press("Escape")
    }
    await goTab(page, "stats")
    await expect(page.getByText("be_e2e").first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole("button", { name: "drain" }).first()).toBeVisible({ timeout: 5_000 })
  })

  test("traffic tab lists frontend/backend stat rows", async ({ page }) => {
    test.skip(!nodeId, "node not created")
    await page.goto(`/nodes/${nodeId}`)
    await goTab(page, "traffic")
    await expect(page.getByText("Frontends", { exact: true })).toBeVisible()
    await expect(page.getByText("Backends", { exact: true })).toBeVisible()
  })

  test("Rules tab: create and delete a redirect rule, switching rule and rate limit", async ({ page }) => {
    test.skip(!nodeId, "node not created")
    await page.goto(`/nodes/${nodeId}`)
    // rules need a parent section; recreate the frontend if previous
    // scenarios deleted it (mock is fresh per run)
    await goTab(page, "frontends")
    const hasFe = await page.getByRole("cell", { name: "fe_e2e" }).first().isVisible().catch(() => false)
    if (!hasFe) {
      await page.getByRole("button", { name: "New frontend" }).click()
      await page.getByPlaceholder("name").fill("fe_e2e")
      await page.getByPlaceholder("bind address").fill("*")
      await page.getByRole("button", { name: "Create" }).click()
      await expect(page.getByText('Frontend "fe_e2e" created')).toBeVisible({ timeout: 15_000 })
    }
    // a backend is needed for switching rules / rate limit
    await goTab(page, "backends")
    const hasBe = await page.getByRole("cell", { name: "be_e2e" }).first().isVisible().catch(() => false)
    if (!hasBe) {
      await page.getByRole("button", { name: "New backend" }).click()
      await page.getByPlaceholder("name").fill("be_e2e")
      await page.getByRole("button", { name: "Create" }).click()
      await expect(page.getByText('Backend "be_e2e" created')).toBeVisible({ timeout: 15_000 })
    }

    await goTab(page, "rules")
    // HTTP request rules section is rendered for the first frontend
    await expect(page.getByText("HTTP request rules").first()).toBeVisible()
    await page.getByPlaceholder("code (301/302/307/308)").fill("302")
    await page.getByPlaceholder("destination (e.g. /new)").fill("/moved")
    await page.getByRole("button", { name: "Add rule" }).first().click()
    await expect(page.getByText("Rule added").first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("302 → /moved").first()).toBeVisible()
    // remove it again to keep state clean
    await page.getByRole("button", { name: "Delete" }).nth(0).click()
    await expect(page.getByText("Rule removed").first()).toBeVisible({ timeout: 15_000 })

    // switching rule on the frontend targeting be_e2e
    await page.getByLabel("rules section type").click()
    await page.getByRole("option", { name: "Frontend" }).click()
    await page.getByLabel("target backend").click()
    await page.getByRole("option", { name: "be_e2e" }).click()
    await page.getByPlaceholder("condition (e.g. { path_beg /api })").fill("{ path_beg /api }")
    await page.getByRole("button", { name: "Add rule" }).last().click()
    await expect(page.getByText("Rule added").last()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("{ path_beg /api }").first()).toBeVisible()
  })

  test("Rules tab: backend health check and rate-limit preset", async ({ page }) => {
    test.skip(!nodeId, "node not created")
    await page.goto(`/nodes/${nodeId}`)
    await goTab(page, "rules")
    await page.getByLabel("rules section type").click()
    await page.getByRole("option", { name: "Backend" }).click()
    await expect(page.getByText("Active health check expectations")).toBeVisible()

    await page.getByLabel("check type").click()
    await page.getByRole("option", { name: "status" }).click()
    await page.getByLabel("check value").fill("200")
    await page.getByRole("button", { name: "Add check" }).click()
    await expect(page.getByText("Rule added").first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByRole("cell", { name: "200", exact: true }).last()).toBeVisible()

    await page.getByLabel("max requests").fill("50")
    await page.getByRole("button", { name: "Apply rate limit" }).click()
    await expect(page.getByText(/Rate limit applied to/)).toBeVisible({ timeout: 15_000 })
    // track-sc0 + deny rules are now in the request-rules table
    await expect(page.getByText("track-sc0").first()).toBeVisible({ timeout: 15_000 })
    await expect(
      page.getByText(/http_req_rate\(10s\) gt 50/).first(),
    ).toBeVisible({ timeout: 15_000 })
  })

  test("WAF tab: toggle SQL injection preset and bot blocking", async ({ page }) => {
    test.skip(!nodeId, "node not created")
    await page.goto(`/nodes/${nodeId}`)
    // make sure the frontend exists (fresh mock per run keeps state)
    await goTab(page, "frontends")
    const hasFe = await page.getByRole("cell", { name: "fe_e2e" }).first().isVisible().catch(() => false)
    if (!hasFe) {
      await page.getByRole("button", { name: "New frontend" }).click()
      await page.getByPlaceholder("name").fill("fe_e2e")
      await page.getByPlaceholder("bind address").fill("*")
      await page.getByRole("button", { name: "Create" }).click()
      await expect(page.getByText('Frontend "fe_e2e" created')).toBeVisible({ timeout: 15_000 })
    }

    await goTab(page, "waf")
    await expect(page.getByText("WAF protection")).toBeVisible()

    // enable the SQL injection preset
    const sqliRow = page.getByRole("row", { name: /SQL injection/ })
    await sqliRow.getByRole("button", { name: "Enable" }).click()
    await expect(page.getByText("SQL injection enabled")).toBeVisible({ timeout: 15_000 })
    await expect(sqliRow.getByText("active", { exact: true })).toBeVisible()

    // bot blocking seeds signatures and flips active
    const botsRow = page.getByRole("row", { name: /Block bad bots/ })
    await botsRow.getByRole("button", { name: "Enable" }).click()
    await expect(page.getByText("Block bad bots enabled")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("sqlmap").first()).toBeVisible()

    // disable both again to leave clean state
    await sqliRow.getByRole("button", { name: "Disable" }).click()
    await expect(page.getByText("SQL injection disabled")).toBeVisible({ timeout: 15_000 })
    await botsRow.getByRole("button", { name: "Disable" }).click()
    await expect(page.getByText("Block bad bots disabled")).toBeVisible({ timeout: 15_000 })
  })

  test("Review changes: staged diff gates applies when enabled", async ({ page }) => {
    test.skip(!nodeId, "node not created")
    await page.goto(`/nodes/${nodeId}`)
    const toggle = page.getByLabel("review changes toggle")
    await clickUntil(page, toggle, (opts) =>
      expect(toggle).toHaveAttribute("aria-checked", "true", opts),
    )

    // create a frontend — the staged diff must appear before any apply
    await goTab(page, "frontends")
    await page.getByRole("button", { name: "New frontend" }).click()
    await page.getByPlaceholder("name").fill("fe_review")
    await page.getByPlaceholder("bind address").fill("*")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByText("Review changes before apply")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("frontend fe_review").first()).toBeVisible()
    await page.getByRole("button", { name: "Apply change" }).click()
    await expect(page.getByText('Frontend "fe_review" created')).toBeVisible({ timeout: 15_000 })

    // deleting goes through the same gate
    const row = page.getByRole("row", { name: /fe_review/ })
    await row.getByRole("button", { name: "Delete" }).click()
    await expect(page.getByText("Review changes before apply")).toBeVisible({ timeout: 15_000 })
    await page.getByRole("button", { name: "Apply change" }).click()
    await expect(page.getByText('Frontend "fe_review" deleted')).toBeVisible({ timeout: 15_000 })

    // leave review mode off for the remaining scenarios
    await clickUntil(page, toggle, (opts) =>
      expect(toggle).toHaveAttribute("aria-checked", "false", opts),
    )
  })

  test("users page: create and delete a user", async ({ page }) => {
    await page.goto("/users")
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible()
    await page.waitForLoadState("networkidle")
    const username = `u${Date.now().toString(36)}`
    await page.getByLabel("username").fill(username)
    await page.getByLabel("password").fill("secret123")
    await clickUntil(
      page,
      page.getByRole("button", { name: "Create user" }),
      (opts) => expect(page.getByText(`User "${username}" created`)).toBeVisible(opts),
    )
    await expect(page.getByText(username).first()).toBeVisible()
    // delete it (the row's Delete button in that user's row)
    const row = page.getByRole("row", { name: new RegExp(username) })
    await row.getByRole("button", { name: "Delete" }).click()
    await page.getByRole("button", { name: "Delete", exact: true }).last().click()
    await expect(page.getByText(`User "${username}" deleted`)).toBeVisible({ timeout: 15_000 })
  })
})
