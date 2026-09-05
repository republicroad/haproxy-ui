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

  test("node detail renders all ten tabs", async ({ page }) => {
    test.skip(!nodeId, "node not created")
    await page.goto(`/nodes/${nodeId}`)
    for (const tab of ["overview", "frontends", "backends", "traffic", "acls", "maps", "stats", "stick", "history", "raw"]) {
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
    await page.getByRole("button", { name: "New backend" }).click()
    await page.getByPlaceholder("name").fill("be_e2e")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByText('Backend "be_e2e" created')).toBeVisible({ timeout: 15_000 })
    await page.getByRole("button", { name: "Servers" }).click()
    await page.getByPlaceholder("server name").fill("srv_e2e")
    await page.getByPlaceholder("address").fill("10.10.10.10")
    await page.getByRole("button", { name: "Add server" }).click()
    await expect(page.getByText("srv_e2e").first()).toBeVisible()
    await page.keyboard.press("Escape")
    await goTab(page, "stats")
    await expect(page.getByText("be_e2e").first()).toBeVisible()
    await expect(page.getByRole("button", { name: "drain" }).first()).toBeVisible()
  })

  test("traffic tab lists frontend/backend stat rows", async ({ page }) => {
    test.skip(!nodeId, "node not created")
    await page.goto(`/nodes/${nodeId}`)
    await goTab(page, "traffic")
    await expect(page.getByRole("heading", { name: "Frontends" })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Backends" })).toBeVisible()
  })
})
