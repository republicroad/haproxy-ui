"use client"

import { useQuery } from "@tanstack/react-query"
import { Badge } from "#/components/reui/badge"

type Finding = {
  severity: "high" | "medium" | "low"
  title: string
  detail: string
  where: string
}

type AdvisorResponse = {
  checkedAt: number
  summary: { high: number; medium: number; low: number }
  findings: Finding[]
}

const severityVariant = { high: "destructive", medium: "warning", low: "secondary" } as const

/**
 * Configuration best-practice advisor: static findings over the node's
 * live config (missing backends, health checks, stick-table consistency,
 * orphaned objects).
 */
export function AdvisorPanel({ nodeId }: { nodeId: string }) {
  const q = useQuery({
    queryKey: ["advisor", nodeId],
    queryFn: async (): Promise<AdvisorResponse> => {
      const res = await fetch(`/api/nodes/${nodeId}/advisor`)
      if (!res.ok) throw new Error("advisor unavailable")
      return res.json()
    },
    refetchInterval: 60_000,
    retry: false,
  })

  if (q.isLoading || q.isError || !q.data) return null
  const { summary, findings } = q.data
  if (findings.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">Config advisor</div>
          <Badge variant="success">no findings</Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Static checks passed: routing references, health checks,
          stick-table usage and object references look healthy.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">Config advisor</div>
        <div className="flex gap-1">
          {summary.high > 0 && <Badge variant="destructive">{summary.high} high</Badge>}
          {summary.medium > 0 && <Badge variant="warning">{summary.medium} medium</Badge>}
          {summary.low > 0 && <Badge variant="secondary">{summary.low} low</Badge>}
        </div>
      </div>
      <div className="mt-2 space-y-2">
        {findings.map((f: Finding, i: number) => (
          <div key={i} className="border-t border-border pt-2 first:border-t-0 first:pt-0">
            <div className="flex items-center gap-2">
              <Badge variant={severityVariant[f.severity]}>{f.severity}</Badge>
              <span className="text-sm font-medium">{f.title}</span>
              <span className="font-mono text-xs text-muted-foreground">{f.where}</span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{f.detail}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
