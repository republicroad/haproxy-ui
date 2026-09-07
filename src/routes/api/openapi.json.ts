import { createFileRoute } from "@tanstack/react-router"
import { buildOpenApiSpec } from "#/lib/openapi"

/** Machine-readable API description (import into Swagger UI / Postman). */
export const Route = createFileRoute("/api/openapi/json")({
  server: {
    handlers: {
      GET: async () =>
        Response.json(buildOpenApiSpec(), {
          headers: { "cache-control": "no-store" },
        }),
    },
  },
})
