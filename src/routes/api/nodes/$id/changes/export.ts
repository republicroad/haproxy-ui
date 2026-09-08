import { createFileRoute } from "@tanstack/react-router"
import { listChangesByNode } from "#/lib/db"

function csvEscape(v: unknown): string {
  const s = String(v ?? "")
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Audit trail export (CSV) for a node's configuration change history. */
export const Route = createFileRoute("/api/nodes/$id/changes/export")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const url = new URL(request.url)
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 10_000), 1), 50_000)
        const changes = listChangesByNode(params.id, limit)
        const header = [
          "ts",
          "kind",
          "resource",
          "target",
          "parent",
          "actor",
          "reverted",
          "tx_id",
        ]
        const rows = changes.map((c) =>
          [
            new Date(c.ts).toISOString(),
            c.kind,
            c.resource,
            c.target,
            c.parent ?? "",
            c.actor ?? "",
            c.reverted ? "yes" : "",
            c.txId ?? "",
          ]
            .map(csvEscape)
            .join(","),
        )
        const csv = [header.join(","), ...rows].join("\r\n") + "\r\n"
        return new Response(csv, {
          status: 200,
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="audit-${params.id.slice(0, 8)}.csv"`,
          },
        })
      },
    },
  },
})
