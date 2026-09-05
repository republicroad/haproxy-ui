import { createFileRoute } from "@tanstack/react-router"
import { exportNodeConfig } from "#/lib/configExport"
import type { Frontend } from "#/lib/types"
import { serversOf } from "#/lib/normalize"

type Entry = Record<string, unknown> & { name: string }

function byName<T extends Entry>(list: T[]): Map<string, T> {
  return new Map(list.map((x) => [x.name, x]))
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    )
  }
  return value
}

function changedFields(a: Entry, b: Entry): string[] {
  const diffs: string[] = []
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (k === "name") continue
    if (JSON.stringify(stable(a[k])) !== JSON.stringify(stable(b[k]))) {
      diffs.push(k)
    }
  }
  return diffs
}

export const Route = createFileRoute("/api/nodes/diff")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const aId = url.searchParams.get("a")
        const bId = url.searchParams.get("b")
        if (!aId || !bId) {
          return Response.json(
            { error: "provide ?a={nodeId}&b={nodeId}" },
            { status: 400 },
          )
        }
        if (aId === bId) {
          return Response.json({ error: "pick two different nodes" }, { status: 400 })
        }
        const [aRes, bRes] = await Promise.all([
          exportNodeConfig(aId),
          exportNodeConfig(bId),
        ])
        if (!aRes.ok || !bRes.ok) {
          const error = !aRes.ok ? aRes.error : !bRes.ok ? bRes.error : "unknown"
          return Response.json(
            { error },
            { status: error === "node not found" ? 404 : 502 },
          )
        }
        const a = aRes.bundle
        const b = bRes.bundle

        const feA = byName(a.frontends)
        const feB = byName(b.frontends)
        const beA = byName(a.backends)
        const beB = byName(b.backends)

        const frontendOnlyIn = (src: Map<string, Frontend>, other: Map<string, Frontend>) =>
          [...src.keys()].filter((k) => !other.has(k))
        const feOnlyA = frontendOnlyIn(feA, feB)
        const feOnlyB = frontendOnlyIn(feB, feA)
        const feChanged = [...feA.keys()]
          .filter((k) => feB.has(k) && changedFields(feA.get(k)!, feB.get(k)!).length > 0)
          .map((name) => ({ name, fields: changedFields(feA.get(name)!, feB.get(name)!) }))

        const beOnlyA = [...beA.keys()].filter((k) => !beB.has(k))
        const beOnlyB = [...beB.keys()].filter((k) => !beA.has(k))
        const beChanged = [...beA.keys()]
          .filter((k) => {
            if (!beB.has(k)) return false
            const aServers = JSON.stringify(
              stable(serversOf(beA.get(k)!).map((s) => stable(s))),
            )
            const bServers = JSON.stringify(
              stable(serversOf(beB.get(k)!).map((s) => stable(s))),
            )
            return (
              changedFields(beA.get(k)!, beB.get(k)!).some((f) => f !== "servers") ||
              aServers !== bServers
            )
          })
          .map((name) => {
            const aBe = beA.get(name)!
            const bBe = beB.get(name)!
            const fields = changedFields(
              { ...aBe, servers: undefined },
              { ...bBe, servers: undefined },
            )
            const aServers = serversOf(aBe).map((s) => s.name).sort()
            const bServers = serversOf(bBe).map((s) => s.name).sort()
            const serverDiff =
              JSON.stringify(aServers) !== JSON.stringify(bServers)
                ? {
                    onlyInA: aServers.filter((s) => !bServers.includes(s)),
                    onlyInB: bServers.filter((s) => !aServers.includes(s)),
                  }
                : null
            return { name, fields, serverDiff }
          })

        return Response.json({
          a: a.sourceNode,
          b: b.sourceNode,
          identical:
            feOnlyA.length === 0 &&
            feOnlyB.length === 0 &&
            beOnlyA.length === 0 &&
            beOnlyB.length === 0 &&
            feChanged.length === 0 &&
            beChanged.length === 0,
          frontends: { onlyInA: feOnlyA, onlyInB: feOnlyB, changed: feChanged },
          backends: { onlyInA: beOnlyA, onlyInB: beOnlyB, changed: beChanged },
        })
      },
    },
  },
})
