import { describe, expect, it } from "vitest"
import { diffLines } from "./diff"

describe("diffLines", () => {
  it("returns no changes for identical inputs", () => {
    const cfg = "global\n  daemon\n\nfrontend fe_a\n  bind *:80\n"
    expect(diffLines(cfg, cfg)).toEqual({ added: [], removed: [] })
  })

  it("detects added lines", () => {
    const { added, removed } = diffLines("a\nb\n", "a\nb\nc\n")
    expect(added).toEqual(["c"])
    expect(removed).toEqual([])
  })

  it("detects removed lines", () => {
    const { added, removed } = diffLines("a\nb\nc\n", "a\nc\n")
    expect(added).toEqual([])
    expect(removed).toEqual(["b"])
  })

  it("detects both added and removed", () => {
    const { added, removed } = diffLines("a\nb\nc\n", "a\nx\nc\n")
    expect(added).toEqual(["x"])
    expect(removed).toEqual(["b"])
  })

  it("handles empty inputs", () => {
    expect(diffLines("", "")).toEqual({ added: [], removed: [] })
    expect(diffLines("", "new\n")).toEqual({ added: ["new"], removed: [] })
    expect(diffLines("old\n", "")).toEqual({ added: [], removed: ["old"] })
  })

  it("recognizes haproxy-style config edits", () => {
    const before = [
      "frontend fe_web",
      "  bind *:80",
      "  default_backend be_web",
      "",
    ].join("\n")
    const after = [
      "frontend fe_web",
      "  bind *:80",
      "  bind *:443",
      "  default_backend be_web",
      "",
    ].join("\n")
    const { added, removed } = diffLines(before, after)
    expect(added).toEqual(["  bind *:443"])
    expect(removed).toEqual([])
  })

  it("caps output at maxLines input slice", () => {
    const many = Array.from({ length: 2000 }, (_, i) => `line-${i}`).join("\n")
    const { added } = diffLines("", many, 800)
    expect(added.length).toBeLessThanOrEqual(800)
  })

  it("uses set-difference fallback for huge inputs", () => {
    const a = Array.from({ length: 600 }, (_, i) => `old-${i}`).join("\n")
    const b = Array.from({ length: 600 }, (_, i) => `new-${i}`).join("\n")
    const { added, removed } = diffLines(a, b)
    expect(added.length).toBe(600)
    expect(removed.length).toBe(600)
  })

  it("preserves order for sequential appends", () => {
    const { added } = diffLines("1\n2\n", "1\n2\n3\n4\n")
    expect(added).toEqual(["3", "4"])
  })
})
