import { createFileRoute } from "@tanstack/react-router"
import { getAlertSettings, setAlertSettings } from "#/lib/db"
import { z } from "zod"
import { fieldErrors } from "#/lib/schemas"

const settingsSchema = z.object({
  webhookUrl: z.string().trim().url({ protocol: /^https?$/ }).or(z.literal("")),
  enabled: z.boolean(),
})

export const Route = createFileRoute("/api/alerts/settings")({
  server: {
    handlers: {
      GET: async () => {
        return Response.json(getAlertSettings())
      },
      PUT: async ({ request }) => {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 })
        }
        const parsed = settingsSchema.safeParse(body)
        if (!parsed.success) {
          return Response.json(
            { error: "validation failed", fields: fieldErrors(parsed.error) },
            { status: 400 },
          )
        }
        if (parsed.data.enabled && !parsed.data.webhookUrl) {
          return Response.json(
            { error: "webhookUrl required when enabled" },
            { status: 400 },
          )
        }
        setAlertSettings(parsed.data)
        return Response.json(getAlertSettings())
      },
    },
  },
})
