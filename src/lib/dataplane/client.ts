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
  kind: "create" | "delete"
  resource: "frontend" | "backend" | "server"
  target: string
  parent?: string
  payload?: unknown
}

/**
 * Run a batch of dataplaneapi writes inside a single transaction, then commit
 * (which triggers haproxy -c validation + graceful reload). On any failure the
 * transaction is rolled back.
 *
 * When `meta` is provided, the committed change is recorded in the app's
 * change history (with a raw config snapshot) for later diff/revert.
 */
export async function withTransaction(
  nodeId: string,
  fn: (txId: string) => Promise<void>,
  meta?: ChangeMeta | ChangeMeta[],
): Promise<void> {
  const version = await dpGet<number>(
    nodeId,
    "services/haproxy/configuration/version",
  )
  const txRes = await dpPost(
    nodeId,
    `services/haproxy/transactions?version=${version}`,
  )
  const tx = (await txRes.json()) as { id: string }
  try {
    await fn(tx.id)
    await fetch(base(nodeId, `services/haproxy/transactions/${tx.id}`), {
      method: "PUT",
    })
  } catch (e) {
    await fetch(base(nodeId, `services/haproxy/transactions/${tx.id}`), {
      method: "DELETE",
    }).catch(() => {})
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
