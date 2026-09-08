import { createFileRoute } from "@tanstack/react-router"
import { isGlobalAdmin, mintApiToken } from "#/lib/auth"
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
  scopeKind: z.enum(["all", "readonly", "group"]).default("all"),
  group: z
    .string()
    .trim()
    .max(32)
    .regex(/^[A-Za-z0-9_.-]+$/, "letters, digits, _ . - only")
    .optional(),
})

export const Route = createFileRoute("/api/tokens")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isGlobalAdmin(request)) {
          return Response.json({ error: "forbidden" }, { status: 403 })
        }
        return Response.json(listApiTokens())
      },
      POST: async ({ request }) => {
        if (!isGlobalAdmin(request)) {
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
        if (parsed.data.scopeKind === "group" && !parsed.data.group) {
          return Response.json(
            { error: "validation failed", fields: { group: "group name is required" } },
            { status: 400 },
          )
        }
        const scope =
          parsed.data.scopeKind === "group"
            ? `group:${parsed.data.group}`
            : parsed.data.scopeKind
        const minted = mintApiToken(parsed.data.name, parsed.data.role, scope)
        return Response.json(
          {
            ok: true,
            id: minted.id,
            name: minted.name,
            role: minted.role,
            scope: minted.scope,
            token: minted.token,
          },
          { status: 201 },
        )
      },
    },
  },
})

