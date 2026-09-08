import { expect, test } from "@playwright/test"

/**
 * OIDC/SSO sign-in against the stub IdP (tests/helpers/oidc-idp.mjs,
 * started by scripts/dev-e2e.mjs). Runs without storage state: the whole
 * point is to obtain a session via the provider.
 */
test.describe.serial("SSO sign-in", () => {
  test("login page offers SSO and a full round-trip signs in", async ({ page }) => {
    await page.goto("/login")
    await expect(page.getByRole("button", { name: "Sign in with SSO" })).toBeVisible({
      timeout: 15_000,
    })

    // authorize → auto-approve → callback → session → app
    await page.getByRole("button", { name: "Sign in with SSO" }).click()
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible({
      timeout: 20_000,
    })

    // the SSO subject was provisioned as an admin (email allowlist), so the
    // users page must render instead of the "admin access required" stub
    await page.goto("/users")
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible()
    await expect(page.getByText("admin@example.com").first()).toBeVisible()
  })
})
