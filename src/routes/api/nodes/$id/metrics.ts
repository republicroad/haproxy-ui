import { createFileRoute } from "@tanstack/react-router"
import { listMetricSamples } from "#/lib/db"

export const Route = createFileRoute("/api/nodes/$id/metrics")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const url = new URL(request.url)
        const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get("hours") ?? 24)))
        const objType = url.searchParams.get("type") ?? undefined
        const objName = url.searchParams.get("name") ?? undefined
        let samples = listMetricSamples(params.id, hours, objType ?? undefined)
        if (objName) samples = samples.filter((s) => s.objName === objName)
        return Response.json({ samples, hours })
      },
    },
  },
})
