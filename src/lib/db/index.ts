import { DatabaseSync } from "node:sqlite"
import { decryptSecret, encryptSecret, isEncrypted } from "#/lib/crypto"

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
  CREATE TABLE IF NOT EXISTS config_changes (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    resource TEXT NOT NULL,
    target TEXT NOT NULL,
    parent TEXT,
    payload TEXT,
    tx_id TEXT,
    reverted INTEGER NOT NULL DEFAULT 0,
    raw_after TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_changes_node ON config_changes(node_id, ts);
`)

/** Encrypt any legacy plaintext api_pass values when HAPROXY_UI_KEY is set. */
function migratePlaintextSecrets(): void {
  if (!process.env.HAPROXY_UI_KEY) return
  const rows = db
    .prepare("SELECT id, api_pass FROM nodes WHERE api_pass NOT LIKE 'enc:v1:%'")
    .all() as { id: string; api_pass: string }[]
  for (const r of rows) {
    if (isEncrypted(r.api_pass)) continue
    db.prepare("UPDATE nodes SET api_pass = ? WHERE id = ?").run(
      encryptSecret(r.api_pass),
      r.id,
    )
  }
}
migratePlaintextSecrets()

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
    apiPass: decryptSecret(row.api_pass),
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
  ).run(n.id, n.name, n.apiUrl, n.apiUser, encryptSecret(n.apiPass), n.status, n.createdAt)
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
    vals.push(encryptSecret(patch.apiPass))
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

export type ChangeRow = {
  id: string
  nodeId: string
  ts: number
  kind: string
  resource: string
  target: string
  parent: string | null
  payload: string | null
  txId: string | null
  reverted: number
  rawAfter: string | null
}

type ChangeSqliteRow = {
  id: string
  node_id: string
  ts: number
  kind: string
  resource: string
  target: string
  parent: string | null
  payload: string | null
  tx_id: string | null
  reverted: number
  raw_after: string | null
}

function rowToChange(row: ChangeSqliteRow): ChangeRow {
  return {
    id: row.id,
    nodeId: row.node_id,
    ts: row.ts,
    kind: row.kind,
    resource: row.resource,
    target: row.target,
    parent: row.parent ?? null,
    payload: row.payload ?? null,
    txId: row.tx_id ?? null,
    reverted: row.reverted,
    rawAfter: row.raw_after ?? null,
  }
}

export function insertChange(c: ChangeRow): void {
  db.prepare(
    "INSERT INTO config_changes (id, node_id, ts, kind, resource, target, parent, payload, tx_id, reverted, raw_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    c.id,
    c.nodeId,
    c.ts,
    c.kind,
    c.resource,
    c.target,
    c.parent,
    c.payload,
    c.txId,
    c.reverted,
    c.rawAfter,
  )
}

/** List a node's changes, newest first. raw_after excluded to keep it light. */
export function listChangesByNode(nodeId: string, limit = 50): Omit<ChangeRow, "rawAfter">[] {
  return (
    db
      .prepare(
        "SELECT id, node_id, ts, kind, resource, target, parent, payload, tx_id, reverted FROM config_changes WHERE node_id = ? ORDER BY ts DESC LIMIT ?",
      )
      .all(nodeId, limit) as ChangeSqliteRow[]
  ).map((r) => {
    const { rawAfter: _raw, ...rest } = rowToChange(r)
    return rest
  })
}

export function getChange(id: string): ChangeRow | undefined {
  const row = db.prepare("SELECT * FROM config_changes WHERE id = ?").get(id) as
    | ChangeSqliteRow
    | undefined
  return row ? rowToChange(row) : undefined
}

export function markReverted(id: string): void {
  db.prepare("UPDATE config_changes SET reverted = 1 WHERE id = ?").run(id)
}

export function countChanges(nodeId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS cnt FROM config_changes WHERE node_id = ?")
    .get(nodeId) as { cnt: number }
  return row.cnt
}

/** Delete change records older than `olderThanTs` (unix ms). Returns deleted count. */
export function deleteChangesBefore(nodeId: string, olderThanTs: number): number {
  const r = db
    .prepare("DELETE FROM config_changes WHERE node_id = ? AND ts < ?")
    .run(nodeId, olderThanTs)
  return Number(r.changes)
}

/** Keep only the latest `keepCount` records per node, delete the rest. Returns deleted count. */
export function trimChanges(nodeId: string, keepCount: number): number {
  const ids = db
    .prepare(
      "SELECT id FROM config_changes WHERE node_id = ? ORDER BY ts DESC LIMIT -1 OFFSET ?",
    )
    .all(nodeId, keepCount) as { id: string }[]
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => "?").join(",")
  const r = db
    .prepare(`DELETE FROM config_changes WHERE id IN (${placeholders})`)
    .run(...ids.map((i) => i.id))
  return Number(r.changes)
}
