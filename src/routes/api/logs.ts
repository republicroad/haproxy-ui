import { createFileRoute } from "@tanstack/react-router"
import { listLogRecords } from "#/lib/db"

/**
 * Query the ingested access-log records (UDP syslog receiver).
 * Filters: node, frontend, status (2|4|5), q (path substring), hours, limit.
 */
export const Route = createFileRoute("/api/logs")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const hoursRaw = url.searchParams.get("hours")
        const limitRaw = url.searchParams.get("limit")
        const statusRaw = url.searchParams.get("status")
        const hours = hoursRaw ? Number(hoursRaw) : 24
        const limit = limitRaw ? Number(limitRaw) : 200
        if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30) {
          return Response.json({ error: "hours must be 1-720" }, { status: 400 })
        }
        if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
          return Response.json({ error: "limit must be 1-1000" }, { status: 400 })
        }
        let statusClass: 2 | 4 | 5 | undefined
        if (statusRaw && ["2", "4", "5"].includes(statusRaw)) {
          statusClass = Number(statusRaw) as 2 | 4 | 5
        }
        return Response.json(
          listLogRecords({
            nodeId: url.searchParams.get("node") ?? undefined,
            frontend: url.searchParams.get("frontend") ?? undefined,
            statusClass,
            pathContains: url.searchParams.get("q") ?? undefined,
            hours,
            limit,
          }),
        )
      },
    },
  },
})
