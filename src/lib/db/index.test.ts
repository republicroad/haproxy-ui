import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

type DbModule = typeof import("./index")

let currentDbPath: string | null = null

async function loadDb(dbPath?: string): Promise<DbModule> {
  const path = dbPath ?? join(mkdtempSync(join(tmpdir(), "haproxy-ui-test-")), "test.db")
  currentDbPath = path
  process.env.HAPROXY_UI_DB = path
  delete (globalThis as Record<string, unknown>).__haproxyUiDb
  vi.resetModules()
  return import("./index")
}

/** Simulate an app restart against the same SQLite file. */
async function reloadDb(): Promise<DbModule> {
  if (!currentDbPath) throw new Error("no db loaded yet")
  return loadDb(currentDbPath)
}

const node = (id: string, name = "n1") => ({
  id,
  name,
  apiUrl: "http://localhost:5555",
  apiUser: "admin",
  apiPass: "admin",
  haproxyVersion: null,
  status: "unknown",
  lastSeen: null,
  createdAt: 1_000,
  group: null,
})

const change = (id: string, nodeId: string, ts: number) => ({
  id,
  nodeId,
  ts,
  kind: "create",
  resource: "backend",
  target: `be_${ts}`,
  parent: null,
  payload: null,
  txId: null,
  reverted: 0,
  rawAfter: null,
  actor: null,
})

describe("db node CRUD", () => {
  let dbm: DbModule
  beforeEach(async () => {
    dbm = await loadDb()
  })

  it("inserts and lists nodes newest first", () => {
    dbm.insertNode(node("a", "first"))
    const second = { ...node("b", "second"), createdAt: 2_000 }
    dbm.insertNode(second)
    const all = dbm.listNodes()
    expect(all.map((n) => n.id)).toEqual(["b", "a"])
  })

  it("gets a node by id", () => {
    dbm.insertNode(node("abc"))
    expect(dbm.getNode("abc")?.name).toBe("n1")
    expect(dbm.getNode("missing")).toBeUndefined()
  })

  it("patches only provided fields", () => {
    dbm.insertNode(node("abc"))
    dbm.updateNode("abc", { status: "up", haproxyVersion: "2.8.4" })
    const n = dbm.getNode("abc")!
    expect(n.status).toBe("up")
    expect(n.haproxyVersion).toBe("2.8.4")
    expect(n.apiUrl).toBe("http://localhost:5555")
  })

  it("deletes nodes", () => {
    dbm.insertNode(node("abc"))
    dbm.deleteNode("abc")
    expect(dbm.getNode("abc")).toBeUndefined()
  })
})

describe("db credential encryption", () => {
  let dbm: DbModule
  beforeEach(async () => {
    process.env.HAPROXY_UI_KEY = "test-enc-key"
    dbm = await loadDb()
  })
  afterEach(async () => {
    delete process.env.HAPROXY_UI_KEY
  })

  it("stores api_pass encrypted but returns plaintext", () => {
    dbm.insertNode({ ...node("enc1"), apiPass: "super-secret" })
    // raw row is encrypted, not plaintext
    const raw = (
      dbm.db.prepare("SELECT api_pass FROM nodes WHERE id = ?").get("enc1") as {
        api_pass: string
      }
    ).api_pass
    expect(raw).not.toBe("super-secret")
    expect(raw.startsWith("enc:v1:")).toBe(true)
    // API layer sees plaintext
    expect(dbm.getNode("enc1")?.apiPass).toBe("super-secret")
  })

  it("encrypts patched passwords", () => {
    dbm.insertNode({ ...node("enc2"), apiPass: "first" })
    dbm.updateNode("enc2", { apiPass: "second" })
    expect(dbm.getNode("enc2")?.apiPass).toBe("second")
    const raw = (
      dbm.db.prepare("SELECT api_pass FROM nodes WHERE id = ?").get("enc2") as {
        api_pass: string
      }
    ).api_pass
    expect(raw.startsWith("enc:v1:")).toBe(true)
  })

  it("migrates legacy plaintext rows on startup", async () => {
    // seed a plaintext row directly, then simulate a fresh boot under key
    dbm.insertNode({ ...node("legacy"), apiPass: "legacy-secret" })
    dbm.db
      .prepare("UPDATE nodes SET api_pass = ? WHERE id = ?")
      .run("legacy-secret", "legacy") // bypass encryption = simulate legacy row

    // emulate restart: clear singleton + module cache, reimport with key set
    const migrated = await reloadDb()
    const raw = (
      migrated.db.prepare("SELECT api_pass FROM nodes WHERE id = ?").get("legacy") as {
        api_pass: string
      }
    ).api_pass
    expect(raw.startsWith("enc:v1:")).toBe(true)
    expect(migrated.getNode("legacy")?.apiPass).toBe("legacy-secret")
  })
})

describe("db change history + retention", () => {
  let dbm: DbModule
  beforeEach(async () => {
    dbm = await loadDb()
    dbm.insertNode(node("n1"))
  })

  it("inserts and lists changes newest first, excluding rawAfter", () => {
    dbm.insertChange(change("c1", "n1", 1_000))
    dbm.insertChange({ ...change("c2", "n1", 2_000), rawAfter: "global\n" })
    const list = dbm.listChangesByNode("n1")
    expect(list.map((c) => c.id)).toEqual(["c2", "c1"])
    expect(list[0]).not.toHaveProperty("rawAfter")
  })

  it("counts changes per node", () => {
    dbm.insertChange(change("c1", "n1", 1))
    dbm.insertChange(change("c2", "n1", 2))
    dbm.insertChange(change("c3", "other", 3))
    expect(dbm.countChanges("n1")).toBe(2)
    expect(dbm.countChanges("other")).toBe(1)
    expect(dbm.countChanges("none")).toBe(0)
  })

  it("gets a single change with rawAfter", () => {
    dbm.insertChange({ ...change("c1", "n1", 1), rawAfter: "raw" })
    expect(dbm.getChange("c1")?.rawAfter).toBe("raw")
    expect(dbm.getChange("nope")).toBeUndefined()
  })

  it("marks reverted", () => {
    dbm.insertChange(change("c1", "n1", 1))
    dbm.markReverted("c1")
    expect(dbm.getChange("c1")?.reverted).toBe(1)
  })

  it("deletes changes older than a timestamp", () => {
    for (let i = 0; i < 5; i++) dbm.insertChange(change(`c${i}`, "n1", i * 1_000))
    const deleted = dbm.deleteChangesBefore("n1", 3_000)
    expect(deleted).toBe(3)
    expect(dbm.countChanges("n1")).toBe(2)
    expect(dbm.listChangesByNode("n1").every((c) => c.ts >= 3_000)).toBe(true)
  })

  it("trims to the latest N records", () => {
    for (let i = 0; i < 10; i++) dbm.insertChange(change(`c${i}`, "n1", i * 1_000))
    const deleted = dbm.trimChanges("n1", 3)
    expect(deleted).toBe(7)
    expect(dbm.listChangesByNode("n1").map((c) => c.id)).toEqual(["c9", "c8", "c7"])
  })

  it("trim/delete are no-ops when nothing qualifies", () => {
    dbm.insertChange(change("c1", "n1", 1))
    expect(dbm.trimChanges("n1", 10)).toBe(0)
    expect(dbm.deleteChangesBefore("n1", 0)).toBe(0)
    expect(dbm.countChanges("n1")).toBe(1)
  })
})
