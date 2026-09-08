import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dbPath = join(mkdtempSync(join(tmpdir(), "haproxy-ui-e2e-")), "e2e.db")

// stub OIDC IdP for the SSO scenario (kept alive until vite exits)
const idp = spawn(process.execPath, [join("tests", "helpers", "oidc-idp.mjs")], {
  stdio: "inherit",
  env: {
    OIDC_IDP_PORT: "4444",
    OIDC_IDP_CLIENT_ID: "haproxy-ui-e2e",
    OIDC_IDP_EMAIL: "admin@example.com",
  },
})
process.on("exit", () => idp.kill())

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
      // SSO scenario: provider is the stub IdP; its subject is auto-promoted
      HAPROXY_UI_OIDC_ISSUER: "http://127.0.0.1:4444",
      HAPROXY_UI_OIDC_CLIENT_ID: "haproxy-ui-e2e",
      HAPROXY_UI_OIDC_CLIENT_SECRET: "e2e-secret",
      HAPROXY_UI_OIDC_ADMIN_EMAILS: "admin@example.com",
    },
  },
)
