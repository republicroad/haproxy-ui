import { describe, expect, it } from "vitest"
import {
  BALANCE_ALGORITHMS,
  HAPROXY_MODES,
  backendInputSchema,
  bindSchema,
  changeMetaSchema,
  fieldErrors,
  frontendInputSchema,
  nodeInputSchema,
  nodePatchSchema,
  serverInputSchema,
} from "./schemas"

describe("nodeInputSchema", () => {
  it("accepts a valid node", () => {
    const r = nodeInputSchema.safeParse({
      name: "edge-1",
      apiUrl: "http://10.0.0.1:5555",
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.apiUser).toBe("admin")
      expect(r.data.apiPass).toBe("admin")
    }
  })

  it("accepts explicit credentials", () => {
    const r = nodeInputSchema.safeParse({
      name: "edge-1",
      apiUrl: "https://hap.example.com:5555",
      apiUser: "ops",
      apiPass: "secret",
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.apiUser).toBe("ops")
      expect(r.data.apiPass).toBe("secret")
    }
  })

  it("rejects empty name", () => {
    const r = nodeInputSchema.safeParse({ name: "  ", apiUrl: "http://h:1" })
    expect(r.success).toBe(false)
  })

  it("rejects invalid name characters", () => {
    const r = nodeInputSchema.safeParse({ name: "bad name!", apiUrl: "http://h:1" })
    expect(r.success).toBe(false)
  })

  it("rejects non-http URL schemes", () => {
    for (const url of ["ftp://h:1", "ws://h:1", "not-a-url", ""]) {
      expect(nodeInputSchema.safeParse({ name: "n", apiUrl: url }).success).toBe(false)
    }
  })

  it("rejects names over 63 chars", () => {
    const r = nodeInputSchema.safeParse({ name: "x".repeat(64), apiUrl: "http://h:1" })
    expect(r.success).toBe(false)
  })
})

describe("nodePatchSchema", () => {
  it("accepts partial patches", () => {
    expect(nodePatchSchema.safeParse({ status: "up" }).success).toBe(true)
    expect(nodePatchSchema.safeParse({ lastSeen: null }).success).toBe(true)
  })

  it("rejects empty patch", () => {
    expect(nodePatchSchema.safeParse({}).success).toBe(false)
  })

  it("rejects bad status values", () => {
    expect(nodePatchSchema.safeParse({ status: "offline" }).success).toBe(false)
  })
})

describe("bindSchema", () => {
  it("coerces numeric strings for port", () => {
    const r = bindSchema.safeParse({ address: "*", port: "8080" })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.port).toBe(8080)
  })

  it("rejects out-of-range ports", () => {
    expect(bindSchema.safeParse({ address: "*", port: 0 }).success).toBe(false)
    expect(bindSchema.safeParse({ address: "*", port: 65536 }).success).toBe(false)
    expect(bindSchema.safeParse({ address: "", port: 80 }).success).toBe(false)
  })
})

describe("frontendInputSchema", () => {
  const valid = {
    name: "fe_in",
    bind: [{ address: "*", port: 80 }],
  }

  it("applies defaults", () => {
    const r = frontendInputSchema.safeParse(valid)
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.mode).toBe("http")
  })

  it("requires at least one bind", () => {
    expect(frontendInputSchema.safeParse({ ...valid, bind: [] }).success).toBe(false)
    expect(frontendInputSchema.safeParse({ ...valid, bind: undefined }).success).toBe(false)
  })

  it("rejects invalid mode", () => {
    expect(
      frontendInputSchema.safeParse({ ...valid, mode: "udp" }).success,
    ).toBe(false)
  })
})

describe("serverInputSchema", () => {
  it("applies defaults", () => {
    const r = serverInputSchema.safeParse({ name: "s1", address: "10.0.0.1", port: 80 })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.weight).toBe(100)
      expect(r.data.check).toBe("disabled")
    }
  })

  it("rejects weight out of 0-256", () => {
    expect(
      serverInputSchema.safeParse({ name: "s1", address: "a", port: 80, weight: 257 })
        .success,
    ).toBe(false)
  })
})

describe("backendInputSchema", () => {
  it("applies balance default", () => {
    const r = backendInputSchema.safeParse({ name: "be_in" })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.balance.algorithm).toBe("roundrobin")
  })

  it("accepts every documented balance algorithm", () => {
    for (const algorithm of BALANCE_ALGORITHMS) {
      expect(
        backendInputSchema.safeParse({ name: "b", balance: { algorithm } }).success,
      ).toBe(true)
    }
  })

  it("rejects unknown mode/algorithm", () => {
    expect(
      backendInputSchema.safeParse({ name: "b", mode: "http2" }).success,
    ).toBe(false)
  })
})

describe("changeMetaSchema", () => {
  it("accepts create/delete meta with optional payload", () => {
    expect(
      changeMetaSchema.safeParse({ kind: "create", resource: "backend", target: "b" })
        .success,
    ).toBe(true)
    expect(
      changeMetaSchema.safeParse({
        kind: "delete",
        resource: "server",
        target: "s",
        parent: "b",
        payload: { name: "s" },
      }).success,
    ).toBe(true)
  })

  it("rejects unknown kind/resource", () => {
    expect(
      changeMetaSchema.safeParse({ kind: "update", resource: "backend", target: "b" })
        .success,
    ).toBe(false)
    expect(
      changeMetaSchema.safeParse({ kind: "create", resource: "acl", target: "x" })
        .success,
    ).toBe(false)
  })

  it("rejects rawAfter over 200KB", () => {
    expect(
      changeMetaSchema.safeParse({
        kind: "create",
        resource: "frontend",
        target: "f",
        rawAfter: "x".repeat(200_001),
      }).success,
    ).toBe(false)
  })
})

describe("fieldErrors", () => {
  it("maps issues to field->message", () => {
    const r = nodeInputSchema.safeParse({ name: "", apiUrl: "bad" })
    expect(r.success).toBe(false)
    if (!r.success) {
      const errs = fieldErrors(r.error)
      expect(Object.keys(errs)).toContain("name")
      expect(Object.keys(errs)).toContain("apiUrl")
    }
  })
})

describe("constants", () => {
  it("mode and balance lists are non-empty tuples", () => {
    expect(HAPROXY_MODES.length).toBeGreaterThan(0)
    expect(BALANCE_ALGORITHMS.length).toBeGreaterThan(0)
  })
})
