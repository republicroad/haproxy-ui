import { describe, expect, it } from "vitest"
import { expiringCerts, parsePemCert } from "./certCheck"

const cert = (name: string, validTo: string | null) => ({
  name,
  subject: `CN=${name}`,
  issuer: "CN=test-ca",
  validTo,
})

describe("expiringCerts", () => {
  it("selects expired and soon-expiring certificates, skips unknown dates", () => {
    const in10d = new Date(Date.now() + 10 * 86_400_000).toISOString()
    const in29d = new Date(Date.now() + 29 * 86_400_000).toISOString()
    const in90d = new Date(Date.now() + 90 * 86_400_000).toISOString()
    const expired = new Date(Date.now() - 3 * 86_400_000).toISOString()

    const picked = expiringCerts(
      [cert("soon", in10d), cert("edge", in29d), cert("fine", in90d), cert("dead", expired), cert("unknown", null)],
      30,
    )
    const names = picked.map((c) => c.name).sort()
    expect(names).toEqual(["dead", "edge", "soon"])
    const dead = picked.find((c) => c.name === "dead")!
    expect(dead.expired).toBe(true)
    expect(dead.daysLeft).toBeLessThanOrEqual(-3)
  })

  it("warn window is configurable", () => {
    const in45d = new Date(Date.now() + 45 * 86_400_000).toISOString()
    expect(expiringCerts([cert("mid", in45d)], 30)).toEqual([])
    expect(expiringCerts([cert("mid", in45d)], 60).map((c) => c.name)).toEqual(["mid"])
  })
})

describe("parsePemCert", () => {
  it("rejects garbage PEM", () => {
    const r = parsePemCert("-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----")
    expect(r.ok).toBe(false)
  })
})
