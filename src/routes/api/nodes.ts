import { createFileRoute } from "@tanstack/react-router"
import { insertNode, listNodes } from "#/lib/db"
import { scopeFromRequest } from "#/lib/auth"
import { nodeInputSchema, fieldErrors } from "#/lib/schemas"

export const Route = createFileRoute("/api/nodes")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const scope = scopeFromRequest(request)
        // group-scoped identities only see their own group's nodes
        const nodes =
          scope.kind === "group"
            ? listNodes().filter((n) => n.group === scope.group)
            : listNodes()
        return Response.json(nodes)
      },
      POST: async ({ request }) => {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 })
        }
        const parsed = nodeInputSchema.safeParse(body)
        if (!parsed.success) {
          return Response.json(
            { error: "validation failed", fields: fieldErrors(parsed.error) },
            { status: 400 },
          )
        }
        const input = parsed.data
        const id = crypto.randomUUID()
        const now = Date.now()
        insertNode({
          id,
          name: input.name,
          apiUrl: input.apiUrl,
          apiUser: input.apiUser,
          apiPass: input.apiPass,
          haproxyVersion: null,
          status: "unknown",
          lastSeen: null,
          createdAt: now,
          group: input.group ?? null,
        })
        const created = listNodes().find((n) => n.id === id)
        return Response.json(created, { status: 201 })
      },
    },
  },
})
