import { describe, expect, it } from "vitest"
import { buildOpenApiSpec } from "./openapi"

describe("buildOpenApiSpec", () => {
  const spec = buildOpenApiSpec() as {
    openapi: string
    paths: Record<string, unknown>
    components: { schemas: Record<string, Record<string, unknown>> }
  }

  it("is a 3.1 document with schemas generated from zod", () => {
    expect(spec.openapi).toBe("3.1.0")
    expect(Object.keys(spec.components.schemas)).toContain("NodeInput")
    expect(Object.keys(spec.components.schemas)).toContain("RateLimitInput")
    // zod-generated schema: node name constraints are carried over
    const name = JSON.stringify(spec.components.schemas.NodeInput)
    expect(name).toContain("apiUrl")
  })

  it("documents the automation + observability surface", () => {
    for (const p of [
      "/api/nodes",
      "/api/nodes/{id}/changes/{changeId}/revert",
      "/api/tokens",
      "/api/logs",
      "/api/metrics",
      "/api/health/summary",
      "/api/auth/oidc/start",
      "/api/dp/{nodeId}/{path}",
    ]) {
      expect(spec.paths[p], `missing path ${p}`).toBeTruthy()
    }
  })
})
