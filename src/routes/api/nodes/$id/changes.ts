import { createFileRoute } from "@tanstack/react-router"
import { insertChange, listChangesByNode } from "#/lib/db"
import { changeMetaSchema, fieldErrors } from "#/lib/schemas"

export const Route = createFileRoute("/api/nodes/$id/changes")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        return Response.json(listChangesByNode(params.id))
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
        })
        return Response.json({ id }, { status: 201 })
      },
    },
  },
})
