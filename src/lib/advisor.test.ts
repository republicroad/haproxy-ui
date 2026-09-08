import { describe, expect, it } from "vitest"
import { analyzeConfig } from "./advisor"
import type { Backend, Frontend } from "#/lib/types"

const fe = (name: string, defaultBackend?: string) =>
  ({ name, mode: "http", bind: [], ...(defaultBackend ? { default_backend: defaultBackend } : {}) }) as Frontend

const be = (
  name: string,
  servers: { name?: string; address?: string; port?: number; check?: string }[] = [],
  extra: Record<string, unknown> = {},
) => ({ name, mode: "http", servers, ...extra }) as unknown as Backend

describe("analyzeConfig", () => {
  it("flags frontend without default backend or switching rules", () => {
    const findings = analyzeConfig({
      frontends: [fe("fe_lonely")],
      backends: [be("be_x", [])],
    })
    expect(findings.some((f) => f.where === "frontend/fe_lonely" && f.severity === "medium")).toBe(true)
  })

  it("high severity for default backend pointing at nothing", () => {
    const findings = analyzeConfig({
      frontends: [fe("fe1", "be_missing")],
      backends: [be("be_x", [])],
    })
    const f = findings.find((x) => x.title === "Default backend does not exist")
    expect(f?.severity).toBe("high")
    expect(f?.where).toBe("frontend/fe1")
  })

  it("switching targets count as references", () => {
    const findings = analyzeConfig({
      frontends: [fe("fe1")],
      backends: [be("be_switched", [])],
      switchingTargets: { fe1: ["be_switched"] },
      logTargetCounts: { fe1: 1 },
    })
    expect(
      findings.some((f) => f.title.includes("no default backend")),
    ).toBe(false)
    expect(
      findings.some((f) => f.title.includes("not referenced by any frontend")),
    ).toBe(false)
  })

  it("detects track-sc without stick-table and the inverse", () => {
    const rules = [{ type: "track-sc0" }]
    const withTrack = analyzeConfig({
      frontends: [],
      backends: [be("be_r", [{ name: "s1", address: "10.0.0.1", port: 80, check: "enabled" }])],
      backendRequestRules: { be_r: rules },
    })
    expect(
      withTrack.some((f) => f.severity === "high" && f.title.includes("track-sc")),
    ).toBe(true)

    const withTable = analyzeConfig({
      frontends: [],
      backends: [be("be_t", [])],
      backendRequestRules: { be_t: [] },
    }) // no stick_table set → nothing
    expect(withTable.some((f) => f.title.includes("Stick-table"))).toBe(false)

    const orphanTable = analyzeConfig({
      frontends: [],
      backends: [be("be_o", [], { stick_table: { type: "ip" } })],
    })
    expect(
      orphanTable.some((f) => f.severity === "low" && f.title.includes("Stick-table")),
    ).toBe(true)
  })

  it("reports servers without checks and duplicate addresses", () => {
    const findings = analyzeConfig({
      frontends: [],
      backends: [
        be("be_d", [
          { name: "a", address: "10.0.0.1", port: 80, check: "enabled" },
          { name: "b", address: "10.0.0.1", port: 80, check: "enabled" },
          { name: "c", address: "10.0.0.2", port: 80, check: "disabled" },
        ]),
      ],
    })
    expect(findings.some((f) => f.title === "Duplicate server address")).toBe(true)
    expect(
      findings.some(
        (f) => f.title === "Server has no active health check" && f.where.endsWith("server/c"),
      ),
    ).toBe(true)
  })

  it("flags missing log targets", () => {
    const findings = analyzeConfig({
      frontends: [fe("fe_q", "be_x")],
      backends: [be("be_x", [])],
      logTargetCounts: { fe_q: 0 },
    })
    expect(findings.some((f) => f.title === "No log targets")).toBe(true)
  })
})
