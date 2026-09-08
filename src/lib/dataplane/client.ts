import { diffLines } from "#/lib/diff"

const base = (nodeId: string, path: string) => `/api/dp/${nodeId}/${path}`

async function errorText(res: Response): Promise<string> {
  try {
    const j = await res.json()
    if (j?.error) return j.error
    if (j?.message) return j.message
    return JSON.stringify(j)
  } catch {
    return res.statusText
  }
}

export async function dpGet<T>(nodeId: string, path: string): Promise<T> {
  const res = await fetch(base(nodeId, path))
  if (!res.ok) throw new Error(await errorText(res))
  const json = (await res.json()) as unknown
  // dataplaneapi wraps collection responses in { data: [...] }; unwrap.
  if (
    json &&
    typeof json === "object" &&
    !Array.isArray(json) &&
    Array.isArray((json as { data?: unknown }).data)
  ) {
    return (json as { data: unknown }).data as T
  }
  return json as T
}

export async function dpRaw(nodeId: string, path: string): Promise<string> {
  const res = await fetch(base(nodeId, path))
  if (!res.ok) throw new Error(await errorText(res))
  return res.text()
}

async function dpSend(
  nodeId: string,
  path: string,
  method: string,
  body?: unknown,
  txId?: string,
): Promise<Response> {
  const sep = path.includes("?") ? "&" : "?"
  const qs = txId ? `${sep}transaction_id=${encodeURIComponent(txId)}` : ""
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" }
    init.body = JSON.stringify(body)
  }
  const res = await fetch(base(nodeId, path) + qs, init)
  if (!res.ok) throw new Error(await errorText(res))
  return res
}

export async function dpPost(
  nodeId: string,
  path: string,
  body?: unknown,
  txId?: string,
) {
  return dpSend(nodeId, path, "POST", body, txId)
}

export async function dpPut(
  nodeId: string,
  path: string,
  body?: unknown,
  txId?: string,
) {
  return dpSend(nodeId, path, "PUT", body, txId)
}

export async function dpDelete(nodeId: string, path: string, txId?: string) {
  const sep = path.includes("?") ? "&" : "?"
  const qs = txId ? `${sep}transaction_id=${encodeURIComponent(txId)}` : ""
  const res = await fetch(base(nodeId, path) + qs, { method: "DELETE" })
  if (!res.ok) throw new Error(await errorText(res))
  return res
}

export type ChangeMeta = {
  kind: "create" | "delete" | "update"
  resource:
    | "frontend"
    | "backend"
    | "server"
    | "acl"
    | "map"
    | "rule"
    | "log"
    | "userlist"
    | "user"
    | "switch"
    | "check"
    | "ratelimit"
  target: string
  parent?: string
  payload?: unknown
}

/** Lines the staged transaction would add / remove from the raw config. */
export type TransactionDiff = { removed: string[]; added: string[] }

export class ChangeCancelledError extends Error {
  constructor() {
    super("change cancelled before apply")
    this.name = "ChangeCancelledError"
  }
}

type PreviewGate = (diff: TransactionDiff) => Promise<boolean>

/**
 * UI hook for the "review changes before apply" flow. When registered,
 * every transaction is diffed against the live config before commit and
 * the gate decides whether to proceed (true) or roll back (false).
 */
let previewGate: PreviewGate | null = null

export function setTransactionPreviewGate(gate: PreviewGate | null): void {
  previewGate = gate
}

/**
 * Run a batch of dataplaneapi writes inside a single transaction, then commit
 * (which triggers haproxy -c validation + graceful reload). On any failure the
 * transaction is rolled back.
 *
 * When `meta` is provided, the committed change is recorded in the app's
 * change history (with a raw config snapshot) for later diff/revert.
 *
 * When a preview gate is registered (and the user enabled "review
 * changes"), the staged raw config is diffed against the live one and the
 * gate must approve before the transaction is committed.
 */
export async function withTransaction(
  nodeId: string,
  fn: (txId: string) => Promise<void>,
  meta?: ChangeMeta | ChangeMeta[],
): Promise<void> {
  const review = previewGate !== null
  const before = review
    ? await dpRaw(nodeId, "services/haproxy/configuration/raw").catch(() => "")
    : null
  const version = await dpGet<number>(
    nodeId,
    "services/haproxy/configuration/version",
  )
  const txRes = await dpPost(
    nodeId,
    `services/haproxy/transactions?version=${version}`,
  )
  const tx = (await txRes.json()) as { id: string }
  const rollback = () =>
    fetch(base(nodeId, `services/haproxy/transactions/${tx.id}`), {
      method: "DELETE",
    }).catch(() => {})
  try {
    await fn(tx.id)
    if (review && previewGate) {
      // staged config: dataplaneapi honors transaction_id on the raw
      // endpoint; the dev mock applies eagerly, so the live config is the
      // staged one there — either way the diff against `before` is correct.
      const after = await dpRaw(
        nodeId,
        `services/haproxy/configuration/raw?transaction_id=${encodeURIComponent(tx.id)}`,
      ).catch(() => before ?? "")
      const diff = diffLines(before ?? "", after)
      const approved = await previewGate(diff)
      if (!approved) {
        await rollback()
        throw new ChangeCancelledError()
      }
    }
    await fetch(base(nodeId, `services/haproxy/transactions/${tx.id}`), {
      method: "PUT",
    })
  } catch (e) {
    await rollback()
    throw e
  }
  if (meta) {
    try {
      const raw = await dpRaw(nodeId, "services/haproxy/configuration/raw")
      const metas = Array.isArray(meta) ? meta : [meta]
      await Promise.all(
        metas.map((m) =>
          fetch(`/api/nodes/${nodeId}/changes`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...m,
              txId: tx.id,
              rawAfter: raw.slice(0, 200_000),
            }),
          }),
        ),
      )
    } catch {
      // history recording must never break the operation itself
    }
  }
}
