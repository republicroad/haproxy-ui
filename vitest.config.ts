import { defineConfig } from "vitest/config"
import { resolve } from "node:path"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      "#/": resolve(import.meta.dirname, "src") + "/",
    },
  },
})
