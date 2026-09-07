import { z } from "zod"

export const HAPROXY_MODES = ["http", "tcp"] as const
export const BALANCE_ALGORITHMS = [
  "roundrobin",
  "leastconn",
  "source",
  "first",
  "random",
] as const

const nameField = z
  .string()
  .trim()
  .min(1, "name is required")
  .max(63, "name must be at most 63 characters")
  .regex(
    /^[A-Za-z0-9_.-]+$/,
    "name may only contain letters, digits, '_', '-', '.'",
  )

export const nodeInputSchema = z.object({
  name: nameField,
  apiUrl: z.url({
    protocol: /^https?$/,
    error: "apiUrl must be a valid http(s) URL (e.g. http://host:5555)",
  }),
  apiUser: z.string().trim().min(1).default("admin"),
  apiPass: z.string().min(1).default("admin"),
  group: z.string().trim().max(32).optional(),
})

export const nodePatchSchema = z
  .object({
    name: nameField.optional(),
    apiUrl: z
      .url({ protocol: /^https?$/, error: "apiUrl must be a valid http(s) URL" })
      .optional(),
    apiUser: z.string().trim().min(1).optional(),
    apiPass: z.string().min(1).optional(),
    haproxyVersion: z.string().nullable().optional(),
    status: z.enum(["up", "down", "unknown"]).optional(),
    lastSeen: z.number().nullable().optional(),
    group: z.string().trim().max(32).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "empty patch" })

export const bindSchema = z.object({
  address: z.string().trim().min(1, "bind address is required"),
  port: z.coerce.number().int().min(1).max(65535),
  name: z.string().trim().optional(),
})

export const frontendInputSchema = z.object({
  name: nameField,
  mode: z.enum(HAPROXY_MODES).default("http"),
  default_backend: z.string().trim().optional(),
  bind: z.array(bindSchema).min(1, "at least one bind is required"),
  description: z.string().trim().optional(),
})

export const serverInputSchema = z.object({
  name: nameField,
  address: z.string().trim().min(1, "address is required"),
  port: z.coerce.number().int().min(1).max(65535),
  weight: z.coerce.number().int().min(0).max(256).default(100),
  check: z.enum(["enabled", "disabled"]).default("disabled"),
})

export const backendInputSchema = z.object({
  name: nameField,
  mode: z.enum(HAPROXY_MODES).default("http"),
  balance: z
    .object({ algorithm: z.enum(BALANCE_ALGORITHMS).default("roundrobin") })
    .default({ algorithm: "roundrobin" }),
  description: z.string().trim().optional(),
})

export const changeMetaSchema = z.object({
  kind: z.enum(["create", "delete", "update"]),
  resource: z.enum([
    "frontend",
    "backend",
    "server",
    "acl",
    "map",
    "rule",
    "log",
    "userlist",
    "user",
    "switch",
    "check",
    "ratelimit",
  ]),
  target: z.string().trim().min(1),
  parent: z.string().trim().optional(),
  payload: z.unknown().optional(),
  txId: z.string().trim().optional(),
  rawAfter: z.string().max(200_000).optional(),
})

export const aclInputSchema = z.object({
  acl_name: z.string().trim().min(1, "acl_name is required"),
  criterion: z.string().trim().min(1, "criterion is required"),
  value: z.string().trim().optional(),
})

export const mapEntryInputSchema = z.object({
  key: z.string().trim().min(1, "key is required"),
  value: z.string().trim().min(1, "value is required"),
})

/** use_backend rule on a frontend: switch to `name` when cond_test holds. */
export const switchingRuleInputSchema = z.object({
  name: nameField,
  cond: z.enum(["if", "unless"]).default("if"),
  cond_test: z.string().trim().min(1, "condition is required"),
})

/** Backend active health check expectation (http-check expect). */
export const healthCheckInputSchema = z.object({
  type: z.enum(["status", "string", "rlen"]),
  value: z.string().trim().min(1, "value is required"),
})

/** Rate-limit preset inputs (stick-table + track + deny on a backend). */
export const rateLimitInputSchema = z.object({
  maxRequests: z.coerce.number().int().min(1).max(1_000_000),
  periodSeconds: z.coerce.number().int().min(1).max(3600).default(10),
  denyStatus: z.coerce.number().int().refine((n) => [403, 429].includes(n), {
    message: "status must be 403 or 429",
  }).default(429),
})

/** Flatten a ZodError into { field: message } for API responses / form display. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_"
    if (!out[key]) out[key] = issue.message
  }
  return out
}
