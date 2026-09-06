"use client"

import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { dpGet } from "#/lib/dataplane/client"
import { normalizeBackends, normalizeFrontends } from "#/lib/normalize"
import type { Frontend, Backend } from "#/lib/types"

type RtServer = {
  name?: string
  address?: string
  operational_state?: string
  admin_state?: string
}

type RtRow = { backend: string; servers: RtServer[] }

const stateColor = (s?: string): string => {
  if (s === "ready" || s === "up" || s === "UP") return "#10b981"
  if (s === "maint") return "#eab308"
  return "#ef4444"
}

export function TopologyView({ nodeId }: { nodeId: string }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const feQ = useQuery({
    queryKey: ["topo-frontends", nodeId],
    queryFn: async () =>
      normalizeFrontends(
        await dpGet<Frontend[]>(nodeId, "services/haproxy/configuration/frontends"),
      ),
    enabled: mounted,
  })
  const beQ = useQuery({
    queryKey: ["topo-backends", nodeId],
    queryFn: async () =>
      normalizeBackends(
        await dpGet<Backend[]>(nodeId, "services/haproxy/configuration/backends"),
      ),
    enabled: mounted,
  })

  const backends = useMemo(
    () => (beQ.data ?? []).filter((b) => !b.name.startsWith("_")),
    [beQ.data],
  )
  const frontends = useMemo(
    () => (feQ.data ?? []).filter((f) => !f.name.startsWith("_")),
    [feQ.data],
  )

  // runtime server states per backend
  const [rt, setRt] = useState<Record<string, RtRow>>({})
  useEffect(() => {
    if (!mounted || backends.length === 0) return
    let cancelled = false
    ;(async () => {
      const out: Record<string, RtRow> = {}
      await Promise.all(
        backends.map(async (b) => {
          try {
            const res = await fetch(
              `/api/dp/${nodeId}/services/haproxy/runtime/backends/${encodeURIComponent(b.name)}/servers`,
            )
            if (!res.ok) return
            const servers = (await res.json()) as RtServer[]
            if (!cancelled) out[b.name] = { backend: b.name, servers: Array.isArray(servers) ? servers : [] }
          } catch {
            // ignore
          }
        }),
      )
      if (!cancelled) setRt(out)
    })()
    return () => {
      cancelled = true
    }
  }, [mounted, nodeId, backends])

  if (!mounted || feQ.isLoading || beQ.isLoading) {
    return <p className="text-sm text-muted-foreground">Building topology…</p>
  }

  if (frontends.length === 0 && backends.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing to draw yet — create frontends/backends first.
      </p>
    )
  }

  const W = 900
  const colX = { fe: 40, be: 380, srv: 660 }
  const rowH = 44
  const feH = Math.max(frontends.length, 1) * rowH
  const beTop = 20
  const beBlockH = backends.length * rowH
  const srvTop = beTop
  const totalH = Math.max(feH, beBlockH, 120) + 40

  const feY = (i: number) => beTop + i * rowH
  const beY = (i: number) => beTop + i * rowH
  const beIdx = new Map(backends.map((b, i) => [b.name, i]))
  const serversOf = (b: Backend) =>
    (rt[b.name]?.servers ?? (b.servers ?? [])).filter((s) => s.name)

  const srvRows = backends.flatMap((b) =>
    serversOf(b).map((s, si) => ({ be: b.name, server: s, y: beY(beIdx.get(b.name)!) + 12 + si * 16 })),
  )
  const srvTotalH = srvRows.length > 0 ? Math.max(...srvRows.map((r) => r.y)) - beTop + 40 : beBlockH
  const total = Math.max(totalH, srvTop + srvTotalH)

  return (
    <div className="overflow-auto rounded-lg border border-border p-2">
      <svg viewBox={`0 0 ${W} ${total}`} className="w-full min-w-[640px]" role="img" aria-label="service topology">
        {/* frontend -> backend links */}
        {frontends.map((f, i) => {
          const target = f.default_backend
          const ti = target ? beIdx.get(target) : undefined
          if (ti === undefined) return null
          return (
            <line
              key={`l-${f.name}`}
              x1={colX.fe + 160}
              y1={feY(i) + 14}
              x2={colX.be}
              y2={beY(ti) + 14}
              stroke="#94a3b8"
              strokeWidth="1.2"
            />
          )
        })}
        {/* backend -> server links */}
        {srvRows.map((r, i) => (
          <line
            key={`ls-${i}`}
            x1={colX.be + 160}
            y1={beY(beIdx.get(r.be)!) + 14}
            x2={colX.srv}
            y2={r.y + 6}
            stroke="#cbd5e1"
            strokeWidth="1"
          />
        ))}

        {/* frontends */}
        {frontends.map((f, i) => (
          <g key={f.name}>
            <rect
              x={colX.fe}
              y={feY(i)}
              width={160}
              height={28}
              rx={6}
              fill="#e0e7ff"
              stroke="#6366f1"
            />
            <text x={colX.fe + 8} y={feY(i) + 18} fontSize="12" fill="#1e1b4b">
              {f.name} :
              {(Array.isArray(f.bind) ? f.bind : []).map((b) => b.port).join("/")}
            </text>
          </g>
        ))}

        {/* backends */}
        {backends.map((b, i) => {
          const st = serversOf(b).some((s) => s.admin_state === "maint")
          return (
            <g key={b.name}>
              <rect
                x={colX.be}
                y={beY(i)}
                width={160}
                height={28}
                rx={6}
                fill={st ? "#fef3c7" : "#dbeafe"}
                stroke={st ? "#d97706" : "#3b82f6"}
              />
              <text x={colX.be + 8} y={beY(i) + 18} fontSize="12" fill="#0c4a6e">
                {b.name}
              </text>
            </g>
          )
        })}

        {/* servers */}
        {srvRows.map((r, i) => {
          const adm = r.server.admin_state ?? "ready"
          const color = stateColor(adm === "ready" ? r.server.operational_state ?? "up" : "maint")
          return (
            <g key={`s-${i}`}>
              <circle cx={colX.srv + 8} cy={r.y + 10} r={5} fill={color} />
              <text x={colX.srv + 20} y={r.y + 14} fontSize="11" fill="#334155">
                {r.server.name}
                {r.server.address ? ` (${r.server.address})` : ""}
              </text>
            </g>
          )
        })}
      </svg>
      <p className="px-2 pb-1 text-xs text-muted-foreground">
        Read-only view: frontends link to their default_backend; server dots are
        colored by runtime state (green up, yellow maint, red down).
      </p>
    </div>
  )
}
