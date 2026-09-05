import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { fieldErrors } from "#/lib/schemas"

const testSchema = z.object({
  webhookUrl: z.string().trim().url({ protocol: /^https?$/ }),
})

export const Route = createFileRoute("/api/alerts/test")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 })
        }
        const parsed = testSchema.safeParse(body)
        if (!parsed.success) {
          return Response.json(
            { error: "validation failed", fields: fieldErrors(parsed.error) },
            { status: 400 },
          )
        }
        try {
          const res = await fetch(parsed.data.webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text: "HAProxy UI test alert",
              event: "test",
              node: null,
              status: null,
              ts: Date.now(),
            }),
            signal: AbortSignal.timeout(5000),
          })
          return Response.json({ ok: res.ok, status: res.status })
        } catch (e) {
          return Response.json(
            { ok: false, error: (e as Error).message },
            { status: 502 },
          )
        }
      },
    },
  },
})
