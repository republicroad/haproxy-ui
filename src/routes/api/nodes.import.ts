import { createFileRoute } from "@tanstack/react-router"
import { insertNode, listNodes } from "#/lib/db"
import { nodeInputSchema, fieldErrors } from "#/lib/schemas"

/** Bulk-import nodes from an export bundle. Existing names are skipped. */
export const Route = createFileRoute("/api/nodes/import")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: "invalid JSON body" }, { status: 400 })
        }
        const arr = (body as { nodes?: unknown[] })?.nodes
        if (!Array.isArray(arr)) {
          return Response.json(
            { error: "body must be { nodes: [...] }" },
            { status: 400 },
          )
        }
        const existing = new Set(listNodes().map((n) => n.name))
        const imported: string[] = []
        const skipped: { name: string; reason: string }[] = []
        for (const raw of arr) {
          const parsed = nodeInputSchema.safeParse(raw)
          if (!parsed.success) {
            const name =
              typeof (raw as { name?: unknown })?.name === "string"
                ? (raw as { name: string }).name
                : "(unnamed)"
            skipped.push({
              name,
              reason: Object.values(fieldErrors(parsed.error)).join("; "),
            })
            continue
          }
          if (existing.has(parsed.data.name)) {
            skipped.push({ name: parsed.data.name, reason: "already exists" })
            continue
          }
          existing.add(parsed.data.name)
          insertNode({
            id: crypto.randomUUID(),
            name: parsed.data.name,
            apiUrl: parsed.data.apiUrl,
            apiUser: parsed.data.apiUser,
            apiPass: parsed.data.apiPass,
            haproxyVersion: null,
            status: "unknown",
            lastSeen: null,
            createdAt: Date.now(),
            group: parsed.data.group ?? null,
          })
          imported.push(parsed.data.name)
        }
        return Response.json({ imported, skipped }, { status: 201 })
      },
    },
  },
})
