import { createFileRoute } from "@tanstack/react-router"
import { mintApiToken, roleFromRequest } from "#/lib/auth"
import { listApiTokens } from "#/lib/db"
import { z } from "zod"
import { fieldErrors } from "#/lib/schemas"

const createSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "name too short")
    .max(32)
    .regex(/^[A-Za-z0-9_.-]+$/, "letters, digits, _ . - only"),
  role: z.enum(["admin", "viewer"]).default("viewer"),
})

export const Route = createFileRoute("/api/tokens")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (roleFromRequest(request) !== "admin") {
          return Response.json({ error: "forbidden" }, { status: 403 })
        }
        return Response.json(listApiTokens())
      },
      POST: async ({ request }) => {
        if (roleFromRequest(request) !== "admin") {
          return Response.json({ error: "forbidden" }, { status: 403 })
        }
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 })
        }
        const parsed = createSchema.safeParse(body)
        if (!parsed.success) {
          return Response.json(
            { error: "validation failed", fields: fieldErrors(parsed.error) },
            { status: 400 },
          )
        }
        const minted = mintApiToken(parsed.data.name, parsed.data.role)
        return Response.json(
          { ok: true, id: minted.id, name: minted.name, role: minted.role, token: minted.token },
          { status: 201 },
        )
      },
    },
  },
})

