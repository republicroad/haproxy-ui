import { getNode } from "#/lib/db"
import { proxyToNode } from "#/lib/dataplane/proxy"
import { normalizeFrontends, normalizeBackends } from "#/lib/normalize"
import type { Frontend, Backend } from "#/lib/types"

async function dpJson<T>(
  nodeId: string,
  path: string,
): Promise<{ status: number; json: T | null; text: string }> {
  const res = await proxyToNode(
    nodeId,
    new Request("http://internal/config-export", { method: "GET" }),
    path,
  )
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, json: json as T | null, text }
}

function unwrap<T>(x: T | { data: T } | null): T | null {
  if (x && typeof x === "object" && !Array.isArray(x) && "data" in x) {
    return (x as { data: T }).data
  }
  return x as T
}

export type ConfigBundle = {
  exportedAt: string
  sourceNode: { name: string; apiUrl: string }
  frontends: Frontend[]
  backends: Backend[]
}

/** Fetch and normalize a node's frontends + backends(+servers) as a bundle. */
export async function exportNodeConfig(nodeId: string): Promise<
  { ok: true; bundle: ConfigBundle } | { ok: false; error: string }
> {
  const node = getNode(nodeId)
  if (!node) return { ok: false, error: "node not found" }
  const fesRes = await dpJson<Frontend[]>(nodeId, "services/haproxy/configuration/frontends")
  const besRes = await dpJson<Backend[]>(nodeId, "services/haproxy/configuration/backends")
  const fes = unwrap(fesRes.json)
  const bes = unwrap(besRes.json)
  if (!fes || !bes) return { ok: false, error: "cannot reach dataplaneapi" }
  const nFes = normalizeFrontends(fes)
  const nBes = normalizeBackends(bes)
  return {
    ok: true,
    bundle: {
      exportedAt: new Date().toISOString(),
      sourceNode: { name: node.name, apiUrl: node.apiUrl },
      frontends: nFes.filter((f) => !f.name.startsWith("_")),
      backends: nBes
        .filter((b) => !b.name.startsWith("_"))
        .map((b) => ({
          ...b,
          servers: (Array.isArray(b.servers) ? b.servers : []).filter(
            (s) => !String(s.name).startsWith("_"),
          ),
        })),
    },
  }
}
