import { expect, test } from "@playwright/test"

/**
 * Multi-node sync with the dry-run preview: the preview computes the
 * per-target plan without writing, then Apply executes it for real.
 */

/** Click and retry until the tab is actually selected (hydration races). */
async function goTab(page, name) {
  const tab = page.getByRole("tab", { name: new RegExp(name) })
  for (let i = 0; i < 6; i++) {
    await tab.click()
    try {
      await expect(tab).toHaveAttribute("aria-selected", "true", { timeout: 1500 })
      return
    } catch {
      // not selected yet — click again
    }
  }
  await expect(tab).toHaveAttribute("aria-selected", "true")
}

test.describe.serial("sync dry-run", () => {
  let sourceId
  let targetId

  test("setup: register source and target nodes", async ({ request }) => {
    const login = await request.post("/api/auth/login", {
      data: { user: "e2e", pass: "e2epass" },
    })
    expect(login.ok()).toBeTruthy()
    const cookie = login
      .headersArray()
      .find((h) => h.name.toLowerCase() === "set-cookie")
      ?.value.split(";")[0]

    for (const [name, url] of [
      ["sync-src", "http://localhost:9090"],
      ["sync-tgt", "http://localhost:9091"],
    ]) {
      const res = await request.post("/api/nodes", {
        headers: { cookie },
        data: { name, apiUrl: url },
      })
      expect(res.ok()).toBeTruthy()
      const j = await res.json()
      if (name === "sync-src") sourceId = j.id
      else targetId = j.id
    }
  })

  test("create a frontend on the source", async ({ page, request }) => {
    // keep the mock state clean if a previous run leaked the frontend
    await request
      .delete(`/api/dp/${sourceId}/services/haproxy/configuration/frontends/fe_sync`)
      .catch(() => {})
    await page.goto(`/nodes/${sourceId}`)
    await goTab(page, "frontends")
    await page.getByRole("button", { name: "New frontend" }).click()
    await page.getByPlaceholder("name").fill("fe_sync")
    await page.getByPlaceholder("bind address").fill("*")
    await page.getByRole("button", { name: "Create" }).click()
    await expect(page.getByText('Frontend "fe_sync" created')).toBeVisible({
      timeout: 15_000,
    })
  })

  test("preview shows the plan without applying, then apply executes it", async ({
    page,
    request,
  }) => {
    await page.goto(`/nodes/${sourceId}`)
    await page.getByRole("button", { name: "Sync to nodes" }).click()

    // select the frontend and the target node
    await page.getByRole("checkbox", { name: /fe_sync/ }).click()
    await page.getByRole("checkbox", { name: /sync-tgt/ }).click()

    await page.getByRole("button", { name: "Preview" }).click()
    await expect(page.getByText("Preview — nothing has been applied")).toBeVisible({
      timeout: 15_000,
    })
    await expect(page.getByText("Would create: frontend/fe_sync")).toBeVisible()
    await expect(page.getByText("analyzed", { exact: true })).toBeVisible()

    // the target must not have received anything yet
    const probe = await request.get(
      `/api/dp/${targetId}/services/haproxy/configuration/frontends`,
    )
    const frontends = (await probe.json()).map((f) => f.name)
    expect(frontends).not.toContain("fe_sync")

    // applying the same plan lands the frontend on the target
    await page.getByRole("button", { name: "Apply to nodes" }).click()
    await expect(page.getByText("Sync finished: 1/1 nodes updated")).toBeVisible({
      timeout: 15_000,
    })

    const after = await request.get(
      `/api/dp/${targetId}/services/haproxy/configuration/frontends`,
    )
    expect((await after.json()).map((f) => f.name)).toContain("fe_sync")
  })
})
