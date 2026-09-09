import { createFileRoute } from "@tanstack/react-router"
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
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

const BACKUP_KEEP = Math.max(1, Number(process.env.HAPROXY_UI_BACKUP_KEEP ?? 20))

/** Delete the oldest snapshots beyond the retention count. */
function pruneOldBackups(dir: string): number {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("haproxy-ui-") && f.endsWith(".db"))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  let removed = 0
  for (const { f } of files.slice(BACKUP_KEEP)) {
    try {
      unlinkSync(join(dir, f))
      removed++
    } catch {
      // best effort
    }
  }
  return removed
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
        // verify the snapshot is a healthy database before reporting success
        let integrity = "ok"
        try {
          const check = new DatabaseSync(target, { readOnly: true })
          const row = check.prepare("PRAGMA quick_check").get() as { quick_check: string }
          check.close()
          integrity = row.quick_check
        } catch (e) {
          integrity = `check failed: ${(e as Error).message}`
        }
        if (integrity !== "ok") {
          return Response.json({ ok: false, name, integrity, dir }, { status: 500 })
        }
        pruneOldBackups(dir)
        const st = statSync(target)
        return Response.json(
          { ok: true, name, size: st.size, dir, integrity },
          { status: 201 },
        )
      },
    },
  },
})
