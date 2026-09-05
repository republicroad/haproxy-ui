import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dbPath = join(mkdtempSync(join(tmpdir(), "haproxy-ui-e2e-")), "e2e.db")

spawnSync(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "dev", "--port", "3999", "--strictPort"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      HAPROXY_UI_DB: dbPath,
      MOCK_PORT: "9090",
      // E2E runs with session auth enabled; tests sign in via
      // tests/auth.setup.mjs (admin) and a viewer account.
      HAPROXY_UI_USER: "e2e",
      HAPROXY_UI_PASS: "e2epass",
    },
  },
)
