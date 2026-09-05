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
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.mjs/,
    },
    {
      name: "app",
      testMatch: /e2e\.spec\.mjs/,
      use: { storageState: "playwright/.auth/admin.json" },
      dependencies: ["setup"],
    },
    {
      name: "viewer",
      testMatch: /viewer\.spec\.mjs/,
      use: { storageState: "playwright/.auth/viewer.json" },
      dependencies: ["setup"],
    },
  ],
})
