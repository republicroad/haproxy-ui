import { describe, expect, it } from "vitest"
import {
  WAF_PRESETS,
  aclIndicesByName,
  aclNameForPreset,
  aclValueForSignature,
  condBotUnknown,
  condTokens,
  denyReferences,
  findDenyIndex,
  signatureFromAclValue,
} from "./waf"

describe("waf bundle naming", () => {
  it("derives acl names and conditions from preset ids", () => {
    expect(aclNameForPreset("sqli")).toBe("waf_sqli")
    expect(condBotUnknown()).toBe("bot_detect !bot_allow")
    expect(WAF_PRESETS.length).toBeGreaterThanOrEqual(5)
    for (const p of WAF_PRESETS) {
      expect(p.acls.length).toBeGreaterThan(0)
      for (const a of p.acls) expect(a.acl_name).toBe(aclNameForPreset(p.id))
    }
  })
})

describe("deny rule condition matching", () => {
  it("tokenizes conditions including negations", () => {
    expect(condTokens("waf_sqli")).toEqual(["waf_sqli"])
    expect(condTokens("  bot_detect   !bot_allow ")).toEqual(["bot_detect", "!bot_allow"])
    expect(condTokens(undefined)).toEqual([])
  })

  it("detects references on deny rules only (negation-aware)", () => {
    const rules = [
      { type: "redirect", http_rule_condition: { cond: "if", val: "waf_sqli" } },
      { type: "deny", http_rule_condition: { cond: "if", val: "bot_detect !bot_allow" } },
    ]
    expect(denyReferences(rules[0], "waf_sqli")).toBe(false)
    expect(denyReferences(rules[1], "bot_detect")).toBe(true)
    expect(denyReferences(rules[1], "bot_allow")).toBe(true) // negated but referenced
    expect(denyReferences(rules[1], "ip_allow")).toBe(false)
    expect(findDenyIndex(rules, "bot_detect")).toBe(1)
    expect(findDenyIndex(rules, "waf_xss")).toBe(-1)
  })
})

describe("acl index bookkeeping", () => {
  it("collects all indexes of a multi-line acl", () => {
    const acls = [
      { acl_name: "other", criterion: "path_beg", value: "/x" },
      { acl_name: "waf_sqli", criterion: "path_reg", value: "-i a" },
      { acl_name: "waf_sqli", criterion: "query_reg", value: "-i b" },
    ]
    expect(aclIndicesByName(acls, "waf_sqli")).toEqual([1, 2])
    expect(aclIndicesByName(acls, "waf_xss")).toEqual([])
  })

  it("round-trips user-agent signatures through the ACL value", () => {
    const v = aclValueForSignature("sqlmap")
    expect(v).toBe("-i -m sub sqlmap")
    expect(signatureFromAclValue(v)).toBe("sqlmap")
    expect(signatureFromAclValue(undefined)).toBe("")
  })
})
