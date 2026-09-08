import { createFileRoute } from "@tanstack/react-router"
import {
  logFrontendBreakdown,
  logSeries,
  logStats,
  topLogClients,
} from "#/lib/db"

/**
 * Aggregated access-log views for the request explorer: totals per
 * status class, request trend buckets, top clients and per-frontend
 * breakdown. All computed SQL-side over the retention window.
 */
export const Route = createFileRoute("/api/logs/stats")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const nodeId = url.searchParams.get("node")
        if (!nodeId) {
          return Response.json({ error: "node parameter is required" }, { status: 400 })
        }
        const hoursRaw = Number(url.searchParams.get("hours") ?? 24)
        if (!Number.isFinite(hoursRaw) || hoursRaw < 1 || hoursRaw > 720) {
          return Response.json({ error: "hours must be 1-720" }, { status: 400 })
        }
        return Response.json({
          stats: logStats(nodeId, hoursRaw),
          series: logSeries(nodeId, hoursRaw, 300),
          topClients: topLogClients(nodeId, hoursRaw, 10),
          frontends: logFrontendBreakdown(nodeId, hoursRaw),
        })
      },
    },
  },
})
