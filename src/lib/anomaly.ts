/**
 * Access-log anomaly detection (pure logic, unit-testable).
 *
 * The maintenance loop feeds per-node window statistics (current = last
 * 5 minutes, baseline = the preceding 30 minutes) and this decides which
 * detectors fire. Every detector requires a meaningful sample size so a
 * handful of requests never raises an alarm.
 */

export type AnomalyKind = "err5xx" | "rate" | "latency"

export type WindowStats = {
  total: number
  err5xx: number
  avgTimeMs: number | null
}

export type AnomalyThresholds = {
  /** percent of 5xx within the window that counts as an error spike */
  err5xxPct: number
  /** current 5-min rate must exceed baseline (per-5-min) rate by this factor */
  rateMult: number
  /** absolute avg latency (ms) above which a latency spike can fire */
  latencyMs: number
  /** minimum requests in the current window for any detector to run */
  minRequests: number
}

export const DEFAULT_THRESHOLDS: AnomalyThresholds = {
  err5xxPct: 20,
  rateMult: 5,
  latencyMs: 2_000,
  minRequests: 50,
}

/** Baseline window is 30 minutes = 6 five-minute buckets. */
const BASELINE_BUCKETS = 6

/** Latency spike factor over the baseline average. */
const LATENCY_FACTOR = 2

export function detectAnomalies(
  current: WindowStats,
  baseline: WindowStats,
  t: AnomalyThresholds = DEFAULT_THRESHOLDS,
): AnomalyKind[] {
  const out: AnomalyKind[] = []
  if (current.total < t.minRequests) return out

  // 1. error-rate spike within the current window
  if (current.err5xx / current.total >= t.err5xxPct / 100) {
    out.push("err5xx")
  }

  // 2. traffic spike vs the baseline rate (requires a meaningful baseline)
  const baselinePerBucket = baseline.total / BASELINE_BUCKETS
  if (baselinePerBucket >= t.minRequests && current.total >= baselinePerBucket * t.rateMult) {
    out.push("rate")
  }

  // 3. latency spike: absolute threshold AND clearly worse than baseline
  if (
    current.avgTimeMs != null &&
    baseline.avgTimeMs != null &&
    current.avgTimeMs >= t.latencyMs &&
    current.avgTimeMs >= baseline.avgTimeMs * LATENCY_FACTOR
  ) {
    out.push("latency")
  }

  return out
}
