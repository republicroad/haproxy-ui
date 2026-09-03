import { createFileRoute } from "@tanstack/react-router"
import { deleteNode, getNode, updateNode } from "#/lib/db"
import { nodePatchSchema, fieldErrors } from "#/lib/schemas"

export const Route = createFileRoute("/api/nodes/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const row = getNode(params.id)
        if (!row) return Response.json({ error: "not found" }, { status: 404 })
        return Response.json(row)
      },
      PUT: async ({ params, request }) => {
        const existing = getNode(params.id)
        if (!existing)
          return Response.json({ error: "not found" }, { status: 404 })
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 })
        }
        const parsed = nodePatchSchema.safeParse(body)
        if (!parsed.success) {
          return Response.json(
            { error: "validation failed", fields: fieldErrors(parsed.error) },
            { status: 400 },
          )
        }
        updateNode(params.id, parsed.data)
        return Response.json(getNode(params.id))
      },
      DELETE: async ({ params }) => {
        deleteNode(params.id)
        return new Response(null, { status: 204 })
      },
    },
  },
})
