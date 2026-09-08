import { createFileRoute } from "@tanstack/react-router"
import { buildOpenApiSpec } from "#/lib/openapi"

/**
 * Machine-readable API description (import into Swagger UI / Postman).
 * Served at /api/openapi — file-route naming cannot express a literal
 * dot in the path.
 */
export const Route = createFileRoute("/api/openapi")({
  server: {
    handlers: {
      GET: async () =>
        Response.json(buildOpenApiSpec(), {
          headers: { "cache-control": "no-store" },
        }),
    },
  },
})
