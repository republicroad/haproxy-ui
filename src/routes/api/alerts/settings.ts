import { createFileRoute } from "@tanstack/react-router"
import { getAlertSettings, getSmtpSettings, setAlertSettings, setSmtpSettings } from "#/lib/db"
import { z } from "zod"
import { fieldErrors } from "#/lib/schemas"

const anomalyFields = {
  anom5xxPct: z.coerce.number().int().min(1).max(100).nullable().optional(),
  anomRateMult: z.coerce.number().int().min(2).max(1000).nullable().optional(),
  anomLatencyMs: z.coerce.number().int().min(100).max(600_000).nullable().optional(),
  anomMinRequests: z.coerce.number().int().min(1).max(100_000).nullable().optional(),
  anomCooldownMin: z.coerce.number().int().min(1).max(1440).nullable().optional(),
}

const settingsSchema = z.object({
  webhookUrl: z.string().trim().url({ protocol: /^https?$/ }).or(z.literal("")).default(""),
  enabled: z.boolean().default(false),
  smtp: z
    .object({
      host: z.string().trim().max(255).default(""),
      port: z.coerce.number().int().min(1).max(65535).default(587),
      secure: z.boolean().default(false),
      username: z.string().trim().max(255).default(""),
      password: z.string().max(255).default(""),
      fromAddr: z.string().trim().max(255).default(""),
      toAddrs: z.string().trim().max(1000).default(""),
      enabled: z.boolean().default(false),
    })
    .optional(),
  anomaly: z.object(anomalyFields).optional(),
})

export const Route = createFileRoute("/api/alerts/settings")({
  server: {
    handlers: {
      GET: async () => {
        const s = getSmtpSettings()
        return Response.json({
          ...getAlertSettings(),
          smtp: {
            ...s,
            // never send the stored password back to the browser
            password: "",
            hasPassword: Boolean(s.password),
            toAddrs: s.toAddrs.join(","),
          },
        })
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
        const data = parsed.data
        if (data.enabled && !data.webhookUrl && !data.smtp?.enabled) {
          return Response.json(
            { error: "webhookUrl required when enabled" },
            { status: 400 },
          )
        }
        if (data.smtp) {
          const current = getSmtpSettings()
          setSmtpSettings({
            host: data.smtp.host,
            port: data.smtp.port,
            secure: data.smtp.secure,
            username: data.smtp.username,
            // empty password keeps the stored one (masked input round-trips)
            password: data.smtp.password === "" ? current.password : data.smtp.password,
            fromAddr: data.smtp.fromAddr,
            toAddrs: data.smtp.toAddrs
              .split(",")
              .map((a) => a.trim())
              .filter(Boolean),
            enabled: data.smtp.enabled,
          })
        }
        setAlertSettings({
          webhookUrl: data.webhookUrl,
          enabled: data.enabled,
          ...(data.anomaly ?? {}),
        })
        return Response.json({ ok: true })
      },
    },
  },
})
