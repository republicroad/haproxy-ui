import { createFileRoute } from "@tanstack/react-router"
import {
  countLogRecordsSince,
  listLatestHealthChecks,
  listMetricSamples,
  listNodes,
} from "#/lib/db"

/**
 * Prometheus scrape endpoint (text/plain; version=0.0.4).
 *
 * Exposes per-node fleet health plus the latest sampled stats for every
 * frontend/backend/server object. Scrapers should authenticate with an
 * API bearer token (Authorization: Bearer ...) when auth is enabled.
 */

type Sample = {
  objType: string
  objName: string
  scur: number | null
  stot: number | null
  reqRate: number | null
  bin: number | null
  bout: number | null
  hrsp2xx: number | null
  hrsp5xx: number | null
  status: string | null
}

function metricLine(
  name: string,
  help: string,
  mtype: "gauge" | "counter",
  samples: { labels: string; value: number | null }[],
): string {
  const lines = [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} ${mtype}`,
  ]
  for (const s of samples) {
    if (s.value == null) continue
    lines.push(`${name}{${s.labels}} ${s.value}`)
  }
  return lines.join("\n")
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
}

function latestByObj(samples: Sample[]): Map<string, Sample> {
  // samples arrive oldest-first; later entries win
  const map = new Map<string, Sample>()
  for (const s of samples) map.set(`${s.objType}/${s.objName}`, s)
  return map
}

export const Route = createFileRoute("/api/metrics")({
  server: {
    handlers: {
      GET: async () => {
        const nodes = listNodes()
        const health = new Map(
          listLatestHealthChecks().map((h) => [h.nodeId, h]),
        )

        const sections: string[] = []

        sections.push(
          metricLine(
            "haproxy_ui_node_up",
            "Whether the node's Data Plane API is reachable (1 = up)",
            "gauge",
            nodes.map((n) => ({
              labels: `node="${escapeLabel(n.name)}",id="${escapeLabel(n.id)}"`,
              value: health.get(n.id) ? (health.get(n.id)!.ok ? 1 : 0) : 0,
            })),
          ),
          metricLine(
            "haproxy_ui_node_probe_latency_milliseconds",
            "Latest Data Plane API probe latency",
            "gauge",
            nodes.map((n) => ({
              labels: `node="${escapeLabel(n.name)}"`,
              value: health.get(n.id)?.latencyMs ?? null,
            })),
          ),
          metricLine(
            "haproxy_ui_node_haproxy_version_info",
            "HAProxy version per node (value is always 1)",
            "gauge",
            nodes
              .filter((n) => n.haproxyVersion)
              .map((n) => ({
                labels: `node="${escapeLabel(n.name)}",version="${escapeLabel(n.haproxyVersion!)}"`,
                value: 1,
              })),
          ),
        )

        for (const n of nodes) {
          const samples = listMetricSamples(n.id, 1)
          const latest = latestByObj(samples)
          const label = (objType: string, objName: string) =>
            `node="${escapeLabel(n.name)}",obj_type="${escapeLabel(objType)}",obj="${escapeLabel(objName)}"`
          const rows = [...latest.values()]

          const gauge = (
            name: string,
            help: string,
            pick: (s: Sample) => number | null,
          ) =>
            sections.push(
              metricLine(
                name,
                help,
                "gauge",
                rows.map((s) => ({ labels: label(s.objType, s.objName), value: pick(s) })),
              ),
            )

          gauge("haproxy_ui_scur", "Current sessions", (s) => s.scur)
          gauge("haproxy_ui_stot", "Total sessions", (s) => s.stot)
          gauge("haproxy_ui_req_rate", "Request rate per second", (s) => s.reqRate)
          gauge("haproxy_ui_bytes_in", "Bytes in", (s) => s.bin)
          gauge("haproxy_ui_bytes_out", "Bytes out", (s) => s.bout)
          gauge("haproxy_ui_http_2xx", "HTTP 2xx responses", (s) => s.hrsp2xx)
          gauge("haproxy_ui_http_5xx", "HTTP 5xx responses", (s) => s.hrsp5xx)
        }

        // ingest request-rate visibility: records captured in the last 5 minutes
        sections.push(
          metricLine(
            "haproxy_ui_log_records_last_5m",
            "Access-log records ingested in the last 5 minutes",
            "gauge",
            nodes.map((n) => ({
              labels: `node="${escapeLabel(n.name)}"`,
              value: countLogRecordsSince(n.id, 300_000),
            })),
          ),
        )

        return new Response(sections.join("\n\n") + "\n", {
          status: 200,
          headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
        })
      },
    },
  },
})
