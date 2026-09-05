import { test } from "@playwright/test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Signs in as the env admin via the login API, creates a viewer account,
 * signs in as the viewer, and persists both session cookies as Playwright
 * storage states used by the "app" and "viewer" projects.
 */
test("auth setup: admin + viewer storage states", async ({ request }) => {
  const dir = join(process.cwd(), "playwright", ".auth")
  mkdirSync(dir, { recursive: true })

  const login = async (user, pass) => {
    const res = await request.post("/api/auth/login", {
      data: { user, pass },
    })
    if (!res.ok()) throw new Error(`login failed for ${user}: ${res.status()}`)
    const setCookie = res
      .headersArray()
      .find((h) => h.name.toLowerCase() === "set-cookie")
    const raw = setCookie?.value ?? ""
    const cookiePart = raw.split(";")[0]
    const [name, value] = cookiePart.split("=")
    return {
      cookies: [
        {
          name,
          value,
          domain: "localhost",
          path: "/",
          httpOnly: true,
          secure: false,
          expires: -1,
          sameSite: "Lax",
        },
      ],
      origins: [],
    }
  }

  const admin = await login("e2e", "e2epass")
  writeFileSync(join(dir, "admin.json"), JSON.stringify(admin))

  // create a viewer for read-only tests (ignore 409 on reruns)
  const mk = await request.post("/api/users", {
    data: { username: "e2eviewer", password: "viewpass", role: "viewer" },
  })
  if (!mk.ok() && mk.status() !== 409) {
    throw new Error(`viewer creation failed: ${mk.status()}`)
  }
  const viewer = await login("e2eviewer", "viewpass")
  writeFileSync(join(dir, "viewer.json"), JSON.stringify(viewer))
})
