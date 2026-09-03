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

/** Flatten a ZodError into { field: message } for API responses / form display. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_"
    if (!out[key]) out[key] = issue.message
  }
  return out
}
