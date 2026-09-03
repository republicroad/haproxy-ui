import { DatabaseSync } from "node:sqlite"

export type NodeRow = {
  id: string
  name: string
  apiUrl: string
  apiUser: string
  apiPass: string
  haproxyVersion: string | null
  status: string
  lastSeen: number | null
  createdAt: number
}

const globalForDb = globalThis as unknown as { __haproxyUiDb?: DatabaseSync }

export const db: DatabaseSync =
  globalForDb.__haproxyUiDb ??
  (globalForDb.__haproxyUiDb = new DatabaseSync(
    process.env.HAPROXY_UI_DB ?? "haproxy-ui.db",
  ))

db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    api_url TEXT NOT NULL,
    api_user TEXT NOT NULL DEFAULT 'admin',
    api_pass TEXT NOT NULL DEFAULT 'admin',
    haproxy_version TEXT,
    status TEXT NOT NULL DEFAULT 'unknown',
    last_seen INTEGER,
    created_at INTEGER NOT NULL
  );
`)

type NodeSqliteRow = {
  id: string
  name: string
  api_url: string
  api_user: string
  api_pass: string
  haproxy_version: string | null
  status: string
  last_seen: number | null
  created_at: number
}

function rowToNode(row: NodeSqliteRow): NodeRow {
  return {
    id: row.id,
    name: row.name,
    apiUrl: row.api_url,
    apiUser: row.api_user,
    apiPass: row.api_pass,
    haproxyVersion: row.haproxy_version ?? null,
    status: row.status,
    lastSeen: row.last_seen ?? null,
    createdAt: row.created_at,
  }
}

export function listNodes(): NodeRow[] {
  return (
    db.prepare("SELECT * FROM nodes ORDER BY created_at DESC").all() as NodeSqliteRow[]
  ).map(rowToNode)
}

export function getNode(id: string): NodeRow | undefined {
  const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as
    | NodeSqliteRow
    | undefined
  return row ? rowToNode(row) : undefined
}

export function insertNode(n: NodeRow): void {
  db.prepare(
    "INSERT INTO nodes (id, name, api_url, api_user, api_pass, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(n.id, n.name, n.apiUrl, n.apiUser, n.apiPass, n.status, n.createdAt)
}

export function updateNode(
  id: string,
  patch: Partial<Pick<NodeRow, "name" | "apiUrl" | "apiUser" | "apiPass" | "haproxyVersion" | "status" | "lastSeen">>,
): void {
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.name !== undefined) {
    sets.push("name = ?")
    vals.push(patch.name)
  }
  if (patch.apiUrl !== undefined) {
    sets.push("api_url = ?")
    vals.push(patch.apiUrl)
  }
  if (patch.apiUser !== undefined) {
    sets.push("api_user = ?")
    vals.push(patch.apiUser)
  }
  if (patch.apiPass !== undefined) {
    sets.push("api_pass = ?")
    vals.push(patch.apiPass)
  }
  if (patch.haproxyVersion !== undefined) {
    sets.push("haproxy_version = ?")
    vals.push(patch.haproxyVersion)
  }
  if (patch.status !== undefined) {
    sets.push("status = ?")
    vals.push(patch.status)
  }
  if (patch.lastSeen !== undefined) {
    sets.push("last_seen = ?")
    vals.push(patch.lastSeen)
  }
  if (sets.length === 0) return
  vals.push(id)
  db.prepare(`UPDATE nodes SET ${sets.join(", ")} WHERE id = ?`).run(
    ...(vals as (string | number | null)[]),
  )
}

export function deleteNode(id: string): void {
  db.prepare("DELETE FROM nodes WHERE id = ?").run(id)
}
