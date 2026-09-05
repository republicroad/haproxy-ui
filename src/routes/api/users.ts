import { createFileRoute } from "@tanstack/react-router"
import { hashPassword, roleFromRequest } from "#/lib/auth"
import { getUser, insertUser, listUsers } from "#/lib/db"
import { publish } from "#/lib/events"
import { z } from "zod"
import { fieldErrors } from "#/lib/schemas"

const createSchema = z.object({
  username: z
    .string()
    .trim()
    .min(2, "username too short")
    .max(32)
    .regex(/^[A-Za-z0-9_.-]+$/, "letters, digits, _ . - only"),
  password: z.string().min(6, "password must be at least 6 characters"),
  role: z.enum(["admin", "viewer"]).default("viewer"),
})

export const Route = createFileRoute("/api/users")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (roleFromRequest(request) !== "admin") {
          return Response.json({ error: "forbidden" }, { status: 403 })
        }
        return Response.json(listUsers())
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
        if (getUser(parsed.data.username)) {
          return Response.json({ error: "user already exists" }, { status: 409 })
        }
        insertUser({
          username: parsed.data.username,
          passHash: hashPassword(parsed.data.password),
          role: parsed.data.role,
        })
        publish({ type: "users_changed" })
        return Response.json({ ok: true, username: parsed.data.username }, { status: 201 })
      },
    },
  },
})
