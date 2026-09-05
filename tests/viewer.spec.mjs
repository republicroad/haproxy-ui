import { expect, test } from "@playwright/test"

/**
 * Viewer role: read-only. Uses the viewer storageState (see auth.setup).
 */
test.describe("viewer role", () => {
  test("viewer can browse nodes", async ({ page, request }) => {
    const res = await request.get("/api/nodes")
    expect(res.status()).toBe(200)
    await page.goto("/nodes")
    await expect(page.getByRole("heading", { name: "Nodes" })).toBeVisible()
  })

  test("viewer writes are forbidden (403)", async ({ request }) => {
    const res = await request.post("/api/nodes", {
      data: { name: "nope", apiUrl: "http://localhost:9090" },
    })
    expect(res.status()).toBe(403)
  })

  test("viewer users management is forbidden", async ({ request }) => {
    const res = await request.get("/api/users")
    expect(res.status()).toBe(403)
  })

  test("users page shows admin-required notice", async ({ page }) => {
    await page.goto("/users")
    await expect(page.getByText("Admin access required.")).toBeVisible()
  })

  test("sidebar hides the Users link for viewers", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0)
  })
})
