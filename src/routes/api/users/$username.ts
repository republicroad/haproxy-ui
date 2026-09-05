import { createFileRoute } from "@tanstack/react-router"
import { hashPassword, roleFromRequest } from "#/lib/auth"
import {
  countAdmins,
  deleteUser,
  getUser,
  updateUser,
} from "#/lib/db"
import { publish } from "#/lib/events"
import { z } from "zod"
import { fieldErrors } from "#/lib/schemas"

const patchSchema = z.object({
  password: z.string().min(6).optional(),
  role: z.enum(["admin", "viewer"]).optional(),
})

export const Route = createFileRoute("/api/users/$username")({
  server: {
    handlers: {
      PUT: async ({ params, request }) => {
        if (roleFromRequest(request) !== "admin") {
          return Response.json({ error: "forbidden" }, { status: 403 })
        }
        const existing = getUser(params.username)
        if (!existing) {
          return Response.json({ error: "user not found" }, { status: 404 })
        }
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 })
        }
        const parsed = patchSchema.safeParse(body)
        if (!parsed.success) {
          return Response.json(
            { error: "validation failed", fields: fieldErrors(parsed.error) },
            { status: 400 },
          )
        }
        const demoting =
          parsed.data.role === "viewer" && existing.role === "admin"
        if (demoting && countAdmins() <= 1) {
          return Response.json(
            { error: "cannot demote the last admin" },
            { status: 409 },
          )
        }
        updateUser(params.username, {
          role: parsed.data.role,
          passHash:
            parsed.data.password !== undefined
              ? hashPassword(parsed.data.password)
              : undefined,
        })
        publish({ type: "users_changed" })
        return Response.json({ ok: true })
      },
      DELETE: async ({ params, request }) => {
        if (roleFromRequest(request) !== "admin") {
          return Response.json({ error: "forbidden" }, { status: 403 })
        }
        const existing = getUser(params.username)
        if (!existing) {
          return Response.json({ error: "user not found" }, { status: 404 })
        }
        if (existing.role === "admin" && countAdmins() <= 1) {
          return Response.json(
            { error: "cannot delete the last admin" },
            { status: 409 },
          )
        }
        deleteUser(params.username)
        publish({ type: "users_changed" })
        return Response.json({ ok: true })
      },
    },
  },
})
