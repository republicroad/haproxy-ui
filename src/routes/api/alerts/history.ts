import { createFileRoute } from "@tanstack/react-router"
import { listAlertHistory } from "#/lib/db"

/** Recent alert notifications (both channels), newest first. */
export const Route = createFileRoute("/api/alerts/history")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const limitRaw = Number(url.searchParams.get("limit") ?? 20)
        const limit = Math.min(Math.max(limitRaw, 1), 100)
        return Response.json(listAlertHistory(limit))
      },
    },
  },
})
