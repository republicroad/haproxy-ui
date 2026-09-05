import { createFileRoute } from "@tanstack/react-router"
import {
  countChanges,
  deleteChangesBefore,
  insertChange,
  listChangesByNode,
  trimChanges,
} from "#/lib/db"
import { actorFromRequest } from "#/lib/auth"
import { publish } from "#/lib/events"
import { changeMetaSchema, fieldErrors } from "#/lib/schemas"

export const Route = createFileRoute("/api/nodes/$id/changes")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        return Response.json({
          changes: listChangesByNode(params.id),
          total: countChanges(params.id),
        })
      },
      POST: async ({ params, request }) => {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 })
        }
        const parsed = changeMetaSchema.safeParse(body)
        if (!parsed.success) {
          return Response.json(
            { error: "validation failed", fields: fieldErrors(parsed.error) },
            { status: 400 },
          )
        }
        const meta = parsed.data
        const id = crypto.randomUUID()
        insertChange({
          id,
          nodeId: params.id,
          ts: Date.now(),
          kind: meta.kind,
          resource: meta.resource,
          target: meta.target,
          parent: meta.parent ?? null,
          payload: meta.payload === undefined ? null : JSON.stringify(meta.payload),
          txId: meta.txId ?? null,
          reverted: 0,
          rawAfter: meta.rawAfter ?? null,
          actor: actorFromRequest(request),
        })
        publish({ type: "change", nodeId: params.id })
        return Response.json({ id }, { status: 201 })
      },
      DELETE: async ({ params, request }) => {
        const url = new URL(request.url)
        const days = url.searchParams.get("days")
        const limit = url.searchParams.get("limit")
        let deleted = 0
        if (days) {
          const d = Number(days)
          if (!Number.isFinite(d) || d < 1) {
            return Response.json({ error: "days must be a positive number" }, { status: 400 })
          }
          deleted = deleteChangesBefore(params.id, Date.now() - d * 86_400_000)
        } else if (limit) {
          const l = Number(limit)
          if (!Number.isFinite(l) || l < 1) {
            return Response.json({ error: "limit must be a positive number" }, { status: 400 })
          }
          deleted = trimChanges(params.id, l)
        } else {
          return Response.json(
            { error: "provide ?days=N or ?limit=N query parameter" },
            { status: 400 },
          )
        }
        return Response.json({ deleted, total: countChanges(params.id) })
      },
    },
  },
})
