import { describe, expect, it } from "vitest"
import { DEFAULT_THRESHOLDS, detectAnomalies } from "./anomaly"

const win = (total: number, err5xx = 0, avgTimeMs: number | null = 50) => ({
  total,
  err5xx,
  avgTimeMs,
})
const T = DEFAULT_THRESHOLDS

describe("detectAnomalies", () => {
  it("ignores small windows entirely", () => {
    expect(detectAnomalies(win(10, 10, 5000), win(100, 0), T)).toEqual([])
  })

  it("fires the 5xx detector above the configured percentage", () => {
    const kinds = detectAnomalies(win(100, 25, 50), win(600, 0), T)
    expect(kinds).toContain("err5xx")
    // just below the threshold → silent
    expect(detectAnomalies(win(100, 19, 50), win(600, 0), T)).not.toContain("err5xx")
  })

  it("fires the rate detector on traffic spikes vs a meaningful baseline", () => {
    // baseline: 600 total in 30 min = 100 per 5-min bucket; current 600 = 6x
    const kinds = detectAnomalies(win(600, 0, 50), win(600, 0), T)
    expect(kinds).toContain("rate")
    // 3x the baseline is under the default 5x multiplier
    expect(detectAnomalies(win(300, 0, 50), win(600, 0), T)).not.toContain("rate")
    // tiny baseline never fires (noisy-neighbor guard)
    expect(detectAnomalies(win(500, 0, 50), win(6, 0), T)).not.toContain("rate")
  })

  it("fires the latency detector only when absolute AND relative thresholds hold", () => {
    // absolute pass, relative pass
    expect(
      detectAnomalies(win(100, 0, 4000), win(600, 0, 500), T),
    ).toContain("latency")
    // relative fails: 500ms vs baseline 400ms
    expect(
      detectAnomalies(win(100, 0, 500), win(600, 0, 400), T),
    ).not.toContain("latency")
    // absolute fails: 400ms < 2000ms even though 4x baseline
    expect(
      detectAnomalies(win(100, 0, 400), win(600, 0, 100), T),
    ).not.toContain("latency")
    // no baseline sample → never fires
    expect(
      detectAnomalies(win(100, 0, 4000), win(600, 0, null), T),
    ).not.toContain("latency")
  })

  it("can fire several detectors at once", () => {
    const kinds = detectAnomalies(win(500, 400, 8000), win(600, 0, 500), T)
    expect(kinds).toEqual(["err5xx", "rate", "latency"])
  })
})
