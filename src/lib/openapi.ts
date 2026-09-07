import { z } from "zod"
import {
  aclInputSchema,
  changeMetaSchema,
  frontendInputSchema,
  backendInputSchema,
  serverInputSchema,
  nodeInputSchema,
  nodePatchSchema,
  switchingRuleInputSchema,
  healthCheckInputSchema,
  rateLimitInputSchema,
} from "#/lib/schemas"

/**
 * OpenAPI 3.1 document for the HAProxy UI REST API. Request/response
 * schemas are generated from the same zod definitions the server
 * validates with (z.toJSONSchema), so the spec cannot drift from the
 * runtime validation.
 */

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>
}

function ref(name: string): Record<string, unknown> {
  return { $ref: `#/components/schemas/${name}` }
}

function op(
  summary: string,
  opts: {
    tag: string
    requestBody?: string
    responses?: Record<string, string>
    params?: string[]
  },
): Record<string, unknown> {
  const responses: Record<string, unknown> = {}
  for (const [code, desc] of Object.entries(opts.responses ?? { "200": "OK" })) {
    responses[code] = { description: desc }
  }
  return {
    summary,
    tags: [opts.tag],
    ...(opts.params
      ? { parameters: opts.params.map((p) => ({ name: p, in: "path", required: true, schema: { type: "string" } })) }
      : {}),
    ...(opts.requestBody
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref(opts.requestBody) } },
          },
        }
      : {}),
    responses,
  }
}

export function buildOpenApiSpec(): Record<string, unknown> {
  const schemaMap: Record<string, z.ZodType> = {
    NodeInput: nodeInputSchema,
    NodePatch: nodePatchSchema,
    FrontendInput: frontendInputSchema,
    BackendInput: backendInputSchema,
    ServerInput: serverInputSchema,
    AclInput: aclInputSchema,
    ChangeMeta: changeMetaSchema,
    SwitchingRuleInput: switchingRuleInputSchema,
    HealthCheckInput: healthCheckInputSchema,
    RateLimitInput: rateLimitInputSchema,
  }
  const schemas = Object.fromEntries(
    Object.entries(schemaMap).map(([name, s]) => [name, jsonSchema(s)]),
  )

  return {
    openapi: "3.1.0",
    info: {
      title: "HAProxy UI API",
      version: "1.1.0",
      description:
        "Management API backing the HAProxy UI. Browser sessions and " +
        "admin-minted bearer tokens (Authorization: Bearer hui_...) both " +
        "authenticate; writes require the admin role.",
    },
    servers: [{ url: "/" }],
    components: { schemas },
    paths: {
      "/api/nodes": {
        get: op("List registered nodes", { tag: "nodes" }),
        post: op("Register a node", { tag: "nodes", requestBody: "NodeInput", responses: { "201": "created" } }),
      },
      "/api/nodes/{id}": {
        get: op("Get one node", { tag: "nodes", params: ["id"] }),
        patch: op("Update node fields", { tag: "nodes", params: ["id"], requestBody: "NodePatch" }),
        delete: op("Remove a node from the registry", { tag: "nodes", params: ["id"] }),
      },
      "/api/nodes/{id}/test": {
        post: op("Run a connectivity test and persist status/version", { tag: "nodes", params: ["id"] }),
      },
      "/api/nodes/export": {
        get: op("Export the node registry (credentials stripped)", { tag: "nodes" }),
      },
      "/api/nodes/import": {
        post: op("Import a node registry", { tag: "nodes" }),
      },
      "/api/nodes/diff": {
        get: op("Compare the configuration of two nodes", { tag: "nodes" }),
      },
      "/api/nodes/{id}/config": {
        get: op("Export a node's full config bundle (JSON)", { tag: "config", params: ["id"] }),
      },
      "/api/nodes/{id}/changes": {
        get: op("List configuration change history", { tag: "history", params: ["id"] }),
        post: op("Record a change meta entry (used by the UI transaction helper)", {
          tag: "history",
          params: ["id"],
          requestBody: "ChangeMeta",
          responses: { "201": "recorded" },
        }),
        delete: op("Clean up old records (?days=N or ?limit=N)", { tag: "history", params: ["id"] }),
      },
      "/api/nodes/{id}/changes/{changeId}/revert": {
        post: op("Revert a create/delete change via a validated transaction", {
          tag: "history",
          params: ["id", "changeId"],
        }),
      },
      "/api/nodes/{id}/upgrade": {
        get: op("List HAProxy binary upgrade runs", { tag: "upgrade", params: ["id"] }),
        post: op("Run an upgrade orchestration step (prepare|verify)", { tag: "upgrade", params: ["id"] }),
      },
      "/api/nodes/{id}/metrics": {
        get: op("Sampled traffic metrics for a node", { tag: "observability", params: ["id"] }),
      },
      "/api/health/summary": {
        get: op("Fleet health summary (probes nodes when stale; ?refresh=1 forces)", {
          tag: "observability",
        }),
      },
      "/api/logs": {
        get: op("Query ingested access-log records (node/frontend/status/q/hours/limit)", {
          tag: "observability",
        }),
      },
      "/api/metrics": {
        get: op("Prometheus exposition endpoint (text/plain; version=0.0.4)", {
          tag: "observability",
          responses: { "200": "Prometheus metrics" },
        }),
      },
      "/api/alerts/settings": {
        get: op("Get alert settings (webhook + SMTP)", { tag: "alerts" }),
        put: op("Update alert settings", { tag: "alerts" }),
      },
      "/api/alerts/test": {
        post: op("Send a test notification (channel: webhook|smtp)", { tag: "alerts" }),
      },
      "/api/auth/login": {
        post: op("Password login (sets the session cookie)", { tag: "auth" }),
      },
      "/api/auth/logout": {
        post: op("Revoke the current session", { tag: "auth" }),
      },
      "/api/auth/status": {
        get: op("Session status probe", { tag: "auth" }),
      },
      "/api/auth/oidc/status": {
        get: op("Whether OIDC/SSO is configured", { tag: "auth" }),
      },
      "/api/auth/oidc/start": {
        get: op("Begin the OIDC authorization-code flow", {
          tag: "auth",
          responses: { "302": "redirect to the identity provider" },
        }),
      },
      "/api/auth/oidc/callback": {
        get: op("OIDC redirect endpoint", {
          tag: "auth",
          responses: { "302": "redirect into the app with a session" },
        }),
      },
      "/api/tokens": {
        get: op("List API tokens (admin only)", { tag: "automation" }),
        post: op("Mint an API token (shown once)", {
          tag: "automation",
          responses: { "201": "minted" },
        }),
      },
      "/api/tokens/{id}": {
        delete: op("Revoke an API token", { tag: "automation", params: ["id"] }),
      },
      "/api/users": {
        get: op("List local users", { tag: "users" }),
        post: op("Create a local user", { tag: "users", responses: { "201": "created" } }),
      },
      "/api/users/{username}": {
        patch: op("Update a user's role or password", { tag: "users", params: ["username"] }),
        delete: op("Delete a user (last admin protected)", { tag: "users", params: ["username"] }),
      },
      "/api/dp/{nodeId}/{path}": {
        get: op("BFF proxy to the node's Data Plane API (credentials injected server-side)", {
          tag: "dataplane",
          params: ["nodeId", "path"],
        }),
        post: op("Proxy POST (transactions and section creates)", {
          tag: "dataplane",
          params: ["nodeId", "path"],
        }),
        put: op("Proxy PUT", { tag: "dataplane", params: ["nodeId", "path"] }),
        delete: op("Proxy DELETE", { tag: "dataplane", params: ["nodeId", "path"] }),
      },
    },
  }
}
