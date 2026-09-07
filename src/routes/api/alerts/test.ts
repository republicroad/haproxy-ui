import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { fieldErrors } from "#/lib/schemas"
import { getSmtpSettings } from "#/lib/db"
import { sendMail } from "#/lib/smtp"

const testSchema = z.object({
  webhookUrl: z
    .string()
    .trim()
    .url({ protocol: /^https?$/ })
    .optional(),
  channel: z.enum(["webhook", "smtp"]).default("webhook"),
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
        if (parsed.data.channel === "smtp") {
          const s = getSmtpSettings()
          if (!s.host || s.toAddrs.length === 0) {
            return Response.json({ ok: false, error: "SMTP host and recipients required" }, { status: 400 })
          }
          try {
            await sendMail(
              {
                host: s.host,
                port: s.port,
                secure: s.secure,
                username: s.username || undefined,
                password: s.password || undefined,
                from: s.fromAddr || "haproxy-ui@localhost",
                to: s.toAddrs,
              },
              "[HAProxy UI] test alert",
              "This is a test notification from HAProxy UI.",
            )
            return Response.json({ ok: true })
          } catch (e) {
            return Response.json({ ok: false, error: (e as Error).message }, { status: 502 })
          }
        }
        if (!parsed.data.webhookUrl) {
          return Response.json({ error: "webhookUrl required" }, { status: 400 })
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
