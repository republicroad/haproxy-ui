import { describe, expect, it } from "vitest"
import {
  normalizeBackend,
  normalizeBackends,
  normalizeFrontend,
  normalizeFrontends,
} from "./normalize"
import type { Backend, Frontend } from "./types"

describe("normalizeFrontend", () => {
  it("keeps array binds untouched", () => {
    const f: Frontend = {
      name: "fe1",
      bind: [{ address: "*", port: 80 }],
    }
    expect(normalizeFrontend(f).bind).toEqual([{ address: "*", port: 80 }])
  })

  it("converts map binds to array (v3 shape)", () => {
    const f = {
      name: "fe1",
      bind: {
        bind_1: { address: "*", port: 80 },
        ":443": { address: "0.0.0.0", port: 443 },
      },
    } as unknown as Frontend
    const result = normalizeFrontend(f)
    expect(Array.isArray(result.bind)).toBe(true)
    if (!Array.isArray(result.bind)) throw new Error("expected array")
    expect(result.bind).toHaveLength(2)
    const ports = result.bind.map((b) => b.port).sort((a: number, b: number) => a - b)
    expect(ports).toEqual([80, 443])
  })

  it("fills name from map key when absent", () => {
    const f = {
      name: "fe1",
      bind: { "bind_1": { address: "*", port: 80 } },
    } as unknown as Frontend
    const result = normalizeFrontend(f)
    if (!Array.isArray(result.bind)) throw new Error("expected array")
    expect(result.bind[0].name).toBe("bind_1")
  })

  it("handles null/undefined binds", () => {
    expect(normalizeFrontend({ name: "f" }).bind).toEqual([])
    expect(normalizeFrontends(null)).toEqual([])
  })
})

describe("normalizeBackend", () => {
  it("keeps array servers untouched", () => {
    const b: Backend = {
      name: "be1",
      servers: [{ name: "s1", address: "10.0.0.1", port: 80 }],
    }
    expect(normalizeBackend(b).servers).toEqual([
      { name: "s1", address: "10.0.0.1", port: 80 },
    ])
  })

  it("converts map servers to array (v3 shape)", () => {
    const b = {
      name: "be1",
      servers: {
        s1: { name: "s1", address: "10.0.0.1", port: 80 },
        s2: { name: "s2", address: "10.0.0.2", port: 81 },
      },
    } as unknown as Backend
    const result = normalizeBackend(b)
    expect(Array.isArray(result.servers)).toBe(true)
    if (!Array.isArray(result.servers)) throw new Error("expected array")
    expect(result.servers.map((s) => s.name).sort()).toEqual(["s1", "s2"])
  })

  it("handles lists and missing fields", () => {
    expect(normalizeBackends(undefined)).toEqual([])
    expect(normalizeBackend({ name: "b" }).servers).toEqual([])
  })
})
