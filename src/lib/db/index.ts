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
  group: string | null
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
    created_at INTEGER NOT NULL,
    node_group TEXT
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
    raw_after TEXT,
    actor TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_changes_node ON config_changes(node_id, ts);
  CREATE TABLE IF NOT EXISTS node_health_checks (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    version TEXT,
    latency_ms INTEGER,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_health_node ON node_health_checks(node_id, ts);
  CREATE TABLE IF NOT EXISTS alert_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    webhook_url TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS smtp_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    host TEXT NOT NULL DEFAULT '',
    port INTEGER NOT NULL DEFAULT 587,
    secure INTEGER NOT NULL DEFAULT 0,
    username TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL DEFAULT '',
    from_addr TEXT NOT NULL DEFAULT '',
    to_addrs TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS alert_state (
    node_id TEXT PRIMARY KEY,
    last_ok INTEGER,
    last_alert_ts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    pass_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'viewer')),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'viewer')),
    created_at INTEGER NOT NULL,
    last_used INTEGER
  );
  CREATE TABLE IF NOT EXISTS metric_samples (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    obj_type TEXT NOT NULL,
    obj_name TEXT NOT NULL,
    scur INTEGER,
    stot INTEGER,
    req_rate INTEGER,
    bin INTEGER,
    bout INTEGER,
    hrsp_2xx INTEGER,
    hrsp_5xx INTEGER,
    status TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_metrics_node_ts ON metric_samples(node_id, obj_name, ts);
  CREATE TABLE IF NOT EXISTS log_records (
    id TEXT PRIMARY KEY,
    node_id TEXT,
    ts INTEGER NOT NULL,
    client_ip TEXT,
    frontend TEXT,
    backend TEXT,
    server TEXT,
    status INTEGER,
    bytes_read INTEGER,
    total_time_ms INTEGER,
    method TEXT,
    path TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_logs_ts ON log_records(ts);
  CREATE INDEX IF NOT EXISTS idx_logs_node_ts ON log_records(node_id, ts);
  CREATE TABLE IF NOT EXISTS upgrade_runs (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    action TEXT NOT NULL,
    from_version TEXT,
    to_version TEXT,
    result TEXT,
    actor TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_upgrade_node ON upgrade_runs(node_id, ts);
`)

// Lightweight migration for databases created before the actor column
// (idempotent: ALTER fails silently when the column already exists).
try {
  db.exec("ALTER TABLE config_changes ADD COLUMN actor TEXT")
} catch {
  // already migrated
}
try {
  db.exec("ALTER TABLE nodes ADD COLUMN node_group TEXT")
} catch {
  // already migrated
}

// Kick off the background maintenance scheduler (retention, backups).
// Dynamic import so the module itself stays test-friendly; unref'd timers.
if (typeof window === "undefined") {
  import("#/lib/maintenance")
    .then((m) => m.startMaintenance())
    .catch(() => {})
}

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
  node_group: string | null
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
    group: row.node_group ?? null,
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
    "INSERT INTO nodes (id, name, api_url, api_user, api_pass, status, created_at, node_group) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(n.id, n.name, n.apiUrl, n.apiUser, encryptSecret(n.apiPass), n.status, n.createdAt, n.group)
}

export function updateNode(
  id: string,
  patch: Partial<
    Pick<NodeRow, "name" | "apiUrl" | "apiUser" | "apiPass" | "haproxyVersion" | "status" | "lastSeen" | "group">
  >,
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
  if (patch.group !== undefined) {
    sets.push("node_group = ?")
    vals.push(patch.group)
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
  actor: string | null
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
  actor: string | null
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
    actor: row.actor ?? null,
  }
}

export function insertChange(c: ChangeRow): void {
  db.prepare(
    "INSERT INTO config_changes (id, node_id, ts, kind, resource, target, parent, payload, tx_id, reverted, raw_after, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    c.actor,
  )
}

/** List a node's changes, newest first. raw_after excluded to keep it light. */
export function listChangesByNode(nodeId: string, limit = 50): Omit<ChangeRow, "rawAfter">[] {
  return (
    db
      .prepare(
        "SELECT id, node_id, ts, kind, resource, target, parent, payload, tx_id, reverted, actor FROM config_changes WHERE node_id = ? ORDER BY ts DESC LIMIT ?",
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

export type HealthCheckRow = {
  id: string
  nodeId: string
  ts: number
  ok: boolean
  version: string | null
  latencyMs: number | null
  error: string | null
}

export function insertHealthCheck(c: Omit<HealthCheckRow, "id">): void {
  db.prepare(
    "INSERT INTO node_health_checks (id, node_id, ts, ok, version, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(crypto.randomUUID(), c.nodeId, c.ts, c.ok ? 1 : 0, c.version, c.latencyMs, c.error)
}

export function listHealthChecks(nodeId: string, limit = 60): Omit<HealthCheckRow, "id">[] {
  return (
    db
      .prepare(
        "SELECT node_id, ts, ok, version, latency_ms, error FROM node_health_checks WHERE node_id = ? ORDER BY ts DESC LIMIT ?",
      )
      .all(nodeId, limit) as {
      node_id: string
      ts: number
      ok: number
      version: string | null
      latency_ms: number | null
      error: string | null
    }[]
  ).map((r) => ({
    nodeId: r.node_id,
    ts: r.ts,
    ok: r.ok === 1,
    version: r.version,
    latencyMs: r.latency_ms,
    error: r.error,
  }))
}

/** Latest health check per node (for dashboards). */
export function listLatestHealthChecks(): (Omit<HealthCheckRow, "id"> & { nodeId: string })[] {
  return (
    db
      .prepare(
        `SELECT h.node_id, h.ts, h.ok, h.version, h.latency_ms, h.error
         FROM node_health_checks h
         JOIN (SELECT node_id, MAX(ts) AS max_ts FROM node_health_checks GROUP BY node_id) m
           ON h.node_id = m.node_id AND h.ts = m.max_ts`,
      )
      .all() as {
      node_id: string
      ts: number
      ok: number
      version: string | null
      latency_ms: number | null
      error: string | null
    }[]
  ).map((r) => ({
    nodeId: r.node_id,
    ts: r.ts,
    ok: r.ok === 1,
    version: r.version,
    latencyMs: r.latency_ms,
    error: r.error,
  }))
}

/** Timestamp of the most recent health check for a node (0 if none). */
export function lastHealthCheckTs(nodeId: string): number {
  const row = db
    .prepare("SELECT MAX(ts) AS m FROM node_health_checks WHERE node_id = ?")
    .get(nodeId) as { m: number | null }
  return row.m ?? 0
}

export function trimHealthChecks(keepCount = 720): void {
  db.exec(`
    DELETE FROM node_health_checks WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY ts DESC) AS rn
        FROM node_health_checks
      ) WHERE rn > ${Math.max(1, keepCount)}
    )
  `)
}

export type AlertSettings = { webhookUrl: string; enabled: boolean }

export function getAlertSettings(): AlertSettings {
  db.exec(
    "INSERT OR IGNORE INTO alert_settings (id, webhook_url, enabled) VALUES (1, '', 0)",
  )
  const row = db
    .prepare("SELECT webhook_url, enabled FROM alert_settings WHERE id = 1")
    .get() as { webhook_url: string; enabled: number }
  return { webhookUrl: row.webhook_url, enabled: row.enabled === 1 }
}

export function setAlertSettings(s: { webhookUrl: string; enabled: boolean }): void {
  db.exec(
    "INSERT OR IGNORE INTO alert_settings (id, webhook_url, enabled) VALUES (1, '', 0)",
  )
  db.prepare("UPDATE alert_settings SET webhook_url = ?, enabled = ? WHERE id = 1").run(
    s.webhookUrl,
    s.enabled ? 1 : 0,
  )
}

export function getAlertState(nodeId: string): { lastOk: boolean | null; lastAlertTs: number } {
  const row = db
    .prepare("SELECT last_ok, last_alert_ts FROM alert_state WHERE node_id = ?")
    .get(nodeId) as { last_ok: number | null; last_alert_ts: number } | undefined
  return {
    lastOk: row?.last_ok == null ? null : row.last_ok === 1,
    lastAlertTs: row?.last_alert_ts ?? 0,
  }
}

export function setAlertState(nodeId: string, lastOk: boolean, lastAlertTs?: number): void {
  db.prepare(
    `INSERT INTO alert_state (node_id, last_ok, last_alert_ts) VALUES (?, ?, ?)
     ON CONFLICT(node_id) DO UPDATE SET last_ok = excluded.last_ok,
     last_alert_ts = COALESCE(?, alert_state.last_alert_ts)`,
  ).run(nodeId, lastOk ? 1 : 0, lastAlertTs ?? 0, lastAlertTs ?? null)
}

export type SmtpSettings = {
  host: string
  port: number
  secure: boolean
  username: string
  password: string
  fromAddr: string
  toAddrs: string[]
  enabled: boolean
}

export function getSmtpSettings(): SmtpSettings {
  db.exec(
    "INSERT OR IGNORE INTO smtp_settings (id) VALUES (1)",
  )
  const row = db
    .prepare(
      "SELECT host, port, secure, username, password, from_addr, to_addrs, enabled FROM smtp_settings WHERE id = 1",
    )
    .get() as {
    host: string
    port: number
    secure: number
    username: string
    password: string
    from_addr: string
    to_addrs: string
    enabled: number
  }
  return {
    host: row.host,
    port: row.port,
    secure: row.secure === 1,
    username: row.username,
    password: decryptSecret(row.password),
    fromAddr: row.from_addr,
    toAddrs: row.to_addrs ? row.to_addrs.split(",") : [],
    enabled: row.enabled === 1,
  }
}

export function setSmtpSettings(s: SmtpSettings): void {
  db.exec("INSERT OR IGNORE INTO smtp_settings (id) VALUES (1)")
  db.prepare(
    "UPDATE smtp_settings SET host = ?, port = ?, secure = ?, username = ?, password = ?, from_addr = ?, to_addrs = ?, enabled = ? WHERE id = 1",
  ).run(
    s.host,
    s.port,
    s.secure ? 1 : 0,
    s.username,
    encryptSecret(s.password),
    s.fromAddr,
    s.toAddrs.join(","),
    s.enabled ? 1 : 0,
  )
}

export type UserRow = {
  username: string
  passHash: string
  role: "admin" | "viewer"
  createdAt: number
}

export function listUsers(): Omit<UserRow, "passHash">[] {
  return (
    db
      .prepare("SELECT username, role, created_at FROM users ORDER BY created_at ASC")
      .all() as { username: string; role: string; created_at: number }[]
  ).map((r) => ({
    username: r.username,
    role: r.role as "admin" | "viewer",
    createdAt: r.created_at,
  }))
}

export function getUser(username: string): UserRow | undefined {
  const row = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as
    | { username: string; pass_hash: string; role: string; created_at: number }
    | undefined
  if (!row) return undefined
  return {
    username: row.username,
    passHash: row.pass_hash,
    role: row.role as "admin" | "viewer",
    createdAt: row.created_at,
  }
}

export function insertUser(u: Omit<UserRow, "createdAt">): void {
  db.prepare(
    "INSERT INTO users (username, pass_hash, role, created_at) VALUES (?, ?, ?, ?)",
  ).run(u.username, u.passHash, u.role, Date.now())
}

export function updateUser(
  username: string,
  patch: { passHash?: string; role?: "admin" | "viewer" },
): void {
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.passHash !== undefined) {
    sets.push("pass_hash = ?")
    vals.push(patch.passHash)
  }
  if (patch.role !== undefined) {
    sets.push("role = ?")
    vals.push(patch.role)
  }
  if (sets.length === 0) return
  vals.push(username)
  db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE username = ?`).run(
    ...(vals as (string | number)[]),
  )
}

export function deleteUser(username: string): void {
  db.prepare("DELETE FROM users WHERE username = ?").run(username)
}

export type ApiTokenRow = {
  id: string
  name: string
  tokenHash: string
  role: "admin" | "viewer"
  createdAt: number
  lastUsed: number | null
}

export function listApiTokens(): Omit<ApiTokenRow, "tokenHash">[] {
  return (
    db
      .prepare(
        "SELECT id, name, role, created_at, last_used FROM api_tokens ORDER BY created_at DESC",
      )
      .all() as { id: string; name: string; role: string; created_at: number; last_used: number | null }[]
  ).map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role as "admin" | "viewer",
    createdAt: r.created_at,
    lastUsed: r.last_used,
  }))
}

export function getApiTokenByHash(tokenHash: string): Omit<ApiTokenRow, "tokenHash"> | undefined {
  const row = db
    .prepare("SELECT id, name, role, created_at, last_used FROM api_tokens WHERE token_hash = ?")
    .get(tokenHash) as
    | { id: string; name: string; role: string; created_at: number; last_used: number | null }
    | undefined
  if (!row) return undefined
  return {
    id: row.id,
    name: row.name,
    role: row.role as "admin" | "viewer",
    createdAt: row.created_at,
    lastUsed: row.last_used,
  }
}

export function insertApiToken(t: Omit<ApiTokenRow, "lastUsed">): void {
  db.prepare(
    "INSERT INTO api_tokens (id, name, token_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(t.id, t.name, t.tokenHash, t.role, t.createdAt)
}

export function deleteApiToken(id: string): void {
  db.prepare("DELETE FROM api_tokens WHERE id = ?").run(id)
}

export function touchApiToken(id: string): void {
  db.prepare("UPDATE api_tokens SET last_used = ? WHERE id = ?").run(Date.now(), id)
}

export function countAdmins(): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'")
    .get() as { c: number }
  return row.c
}

export type MetricSample = {
  nodeId: string
  ts: number
  objType: string
  objName: string
  scur: number | null
  stot: number | null
  reqRate: number | null
  bin: number | null
  bout: number | null
  hrsp2xx: number | null
  hrsp5xx: number | null
  status: string | null
}

export function insertMetricSamples(
  nodeId: string,
  samples: Omit<MetricSample, "nodeId">[],
): void {
  const stmt = db.prepare(
    "INSERT INTO metric_samples (id, node_id, ts, obj_type, obj_name, scur, stot, req_rate, bin, bout, hrsp_2xx, hrsp_5xx, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
  for (const s of samples) {
    stmt.run(
      crypto.randomUUID(),
      nodeId,
      s.ts,
      s.objType,
      s.objName,
      s.scur,
      s.stot,
      s.reqRate,
      s.bin,
      s.bout,
      s.hrsp2xx,
      s.hrsp5xx,
      s.status,
    )
  }
}

/** Metric samples for a node within the last `hours` hours, oldest first. */
export function listMetricSamples(
  nodeId: string,
  hours = 24,
  objType?: string,
): (Omit<MetricSample, "id" | "nodeId"> & { ts: number })[] {
  const since = Date.now() - hours * 3_600_000
  const rows = (
    objType
      ? db
          .prepare(
            "SELECT node_id, ts, obj_type, obj_name, scur, stot, req_rate, bin, bout, hrsp_2xx, hrsp_5xx, status FROM metric_samples WHERE node_id = ? AND ts >= ? AND obj_type = ? ORDER BY ts ASC",
          )
          .all(nodeId, since, objType)
      : db
          .prepare(
            "SELECT node_id, ts, obj_type, obj_name, scur, stot, req_rate, bin, bout, hrsp_2xx, hrsp_5xx, status FROM metric_samples WHERE node_id = ? AND ts >= ? ORDER BY ts ASC",
          )
          .all(nodeId, since)
  ) as {
    node_id: string
    ts: number
    obj_type: string
    obj_name: string
    scur: number | null
    stot: number | null
    req_rate: number | null
    bin: number | null
    bout: number | null
    hrsp_2xx: number | null
    hrsp_5xx: number | null
    status: string | null
  }[]
  return rows.map((r) => ({
    ts: r.ts,
    objType: r.obj_type,
    objName: r.obj_name,
    scur: r.scur,
    stot: r.stot,
    reqRate: r.req_rate,
    bin: r.bin,
    bout: r.bout,
    hrsp2xx: r.hrsp_2xx,
    hrsp5xx: r.hrsp_5xx,
    status: r.status,
  }))
}

/** Purge metric samples older than `hours`. Returns deleted row count. */
export function purgeMetricSamples(keepHours: number): number {
  const cutoff = Date.now() - keepHours * 3_600_000
  const r = db.prepare("DELETE FROM metric_samples WHERE ts < ?").run(cutoff)
  return Number(r.changes)
}

// --- access-log ingestion (UDP syslog receiver) ---

export type LogRecord = {
  nodeId: string | null
  ts: number
  clientIp: string | null
  frontend: string | null
  backend: string | null
  server: string | null
  status: number | null
  bytesRead: number | null
  totalTimeMs: number | null
  method: string | null
  path: string | null
}

export function insertLogRecords(records: LogRecord[]): void {
  const stmt = db.prepare(
    "INSERT INTO log_records (id, node_id, ts, client_ip, frontend, backend, server, status, bytes_read, total_time_ms, method, path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
  for (const r of records) {
    stmt.run(
      crypto.randomUUID(),
      r.nodeId,
      r.ts,
      r.clientIp,
      r.frontend,
      r.backend,
      r.server,
      r.status,
      r.bytesRead,
      r.totalTimeMs,
      r.method,
      r.path,
    )
  }
}

export type LogQuery = {
  nodeId?: string
  frontend?: string
  statusClass?: 2 | 4 | 5
  pathContains?: string
  hours?: number
  limit?: number
}

export function listLogRecords(q: LogQuery = {}): (Omit<LogRecord, "nodeId"> & { nodeId: string | null })[] {
  const where: string[] = []
  const vals: (string | number)[] = []
  if (q.nodeId) {
    where.push("node_id = ?")
    vals.push(q.nodeId)
  }
  if (q.frontend) {
    where.push("frontend = ?")
    vals.push(q.frontend)
  }
  if (q.statusClass) {
    where.push("status >= ? AND status < ?")
    vals.push(q.statusClass * 100, (q.statusClass + 1) * 100)
  }
  if (q.pathContains) {
    where.push("path LIKE ?")
    vals.push(`%${q.pathContains}%`)
  }
  const since = Date.now() - (q.hours ?? 24) * 3_600_000
  where.push("ts >= ?")
  vals.push(since)
  const limit = Math.min(q.limit ?? 200, 1000)
  return (
    db
      .prepare(
        `SELECT node_id, ts, client_ip, frontend, backend, server, status, bytes_read, total_time_ms, method, path
         FROM log_records WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ${limit}`,
      )
      .all(...vals) as {
      node_id: string | null
      ts: number
      client_ip: string | null
      frontend: string | null
      backend: string | null
      server: string | null
      status: number | null
      bytes_read: number | null
      total_time_ms: number | null
      method: string | null
      path: string | null
    }[]
  ).map((r) => ({
    nodeId: r.node_id,
    ts: r.ts,
    clientIp: r.client_ip,
    frontend: r.frontend,
    backend: r.backend,
    server: r.server,
    status: r.status,
    bytesRead: r.bytes_read,
    totalTimeMs: r.total_time_ms,
    method: r.method,
    path: r.path,
  }))
}

/** Purge ingested access-log records older than `hours`. Returns deleted count. */
export function purgeLogRecords(keepHours: number): number {
  const cutoff = Date.now() - keepHours * 3_600_000
  const r = db.prepare("DELETE FROM log_records WHERE ts < ?").run(cutoff)
  return Number(r.changes)
}

// --- HAProxy binary upgrade orchestration ---

export type UpgradeRun = {
  id: string
  nodeId: string
  ts: number
  action: "prepare" | "verify"
  fromVersion: string | null
  toVersion: string | null
  result: string
  actor: string | null
}

export function insertUpgradeRun(r: Omit<UpgradeRun, "id">): string {
  const id = crypto.randomUUID()
  db.prepare(
    "INSERT INTO upgrade_runs (id, node_id, ts, action, from_version, to_version, result, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, r.nodeId, r.ts, r.action, r.fromVersion, r.toVersion, r.result, r.actor)
  return id
}

export function listUpgradeRuns(nodeId: string, limit = 20): Omit<UpgradeRun, "id">[] {
  return (
    db
      .prepare(
        "SELECT node_id, ts, action, from_version, to_version, result, actor FROM upgrade_runs WHERE node_id = ? ORDER BY ts DESC LIMIT ?",
      )
      .all(nodeId, limit) as {
      node_id: string
      ts: number
      action: string
      from_version: string | null
      to_version: string | null
      result: string
      actor: string | null
    }[]
  ).map((r) => ({
    nodeId: r.node_id,
    ts: r.ts,
    action: r.action as "prepare" | "verify",
    fromVersion: r.from_version,
    toVersion: r.to_version,
    result: r.result,
    actor: r.actor,
  }))
}
