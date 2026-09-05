import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "tests",
  timeout: 45_000,
  use: {
    baseURL: "http://localhost:3999",
    headless: true,
  },
  webServer: {
    command: "node scripts/dev-e2e.mjs",
    url: "http://localhost:3999/",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  globalSetup: "tests/global-setup.mjs",
  globalTeardown: "tests/global-teardown.mjs",
})
