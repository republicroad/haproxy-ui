import { createFileRoute } from "@tanstack/react-router"
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { db } from "#/lib/db"
import { isGlobalAdmin } from "#/lib/auth"

/**
 * UI database backups via SQLite `VACUUM INTO` (online, consistent).
 * Files land in HAPROXY_UI_BACKUP_DIR (default ./backups). Restore is a
 * documented manual step: stop the app, replace the DB file, start again
 * (or point litestream at the same directory for continuous backups).
 */

function backupDir(): string {
  const dir = process.env.HAPROXY_UI_BACKUP_DIR
    ? resolve(process.env.HAPROXY_UI_BACKUP_DIR)
    : resolve("backups")
  mkdirSync(dir, { recursive: true })
  return dir
}

export const Route = createFileRoute("/api/db/backup")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isGlobalAdmin(request)) {
          return Response.json({ error: "forbidden" }, { status: 403 })
        }
        const dir = backupDir()
        const files = readdirSync(dir)
          .filter((f) => f.startsWith("haproxy-ui-") && f.endsWith(".db"))
          .map((f) => {
            const st = statSync(join(dir, f))
            return { name: f, size: st.size, mtime: st.mtimeMs }
          })
          .sort((a, b) => b.mtime - a.mtime)
        return Response.json({ dir, files })
      },
      POST: async ({ request }) => {
        if (!isGlobalAdmin(request)) {
          return Response.json({ error: "forbidden" }, { status: 403 })
        }
        const dir = backupDir()
        const name = `haproxy-ui-${new Date()
          .toISOString()
          .replace(/[:.]/g, "-")}.db`
        const target = join(dir, name)
        if (existsSync(target)) {
          return Response.json({ error: "backup name collision" }, { status: 409 })
        }
        // VACUUM INTO produces a compacted, consistent snapshot while online
        db.prepare(`VACUUM INTO ?`).run(target)
        const st = statSync(target)
        return Response.json(
          { ok: true, name, size: st.size, dir },
          { status: 201 },
        )
      },
    },
  },
})
