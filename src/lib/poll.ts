/** Central poll intervals (ms). P7.3 SSE will relax these to fallbacks. */
export const POLL = {
  /** Node lists & node-detail overview info */
  NODES: 15_000,
  /** Runtime server states (stats tab) */
  STATS: 10_000,
  /** Fleet health summary on the overview page */
  HEALTH: 30_000,
  /** Native traffic stats */
  TRAFFIC: 30_000,
  /** Stick tables viewer */
  STICK: 15_000,
} as const
