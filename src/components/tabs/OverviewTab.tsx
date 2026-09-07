import { Alert } from "#/components/reui/alert"

export function OverviewTab({
  info,
  loading,
  error,
}: {
  info?: Record<string, unknown>
  loading: boolean
  error: Error | null
}) {
  if (loading) return <p className="text-muted-foreground">Loading runtime info…</p>
  if (error) return <Alert variant="default">Cannot read node: {error.message}</Alert>
  // dataplaneapi nests the useful fields under "info"; fall back to the top level.
  const src =
    (info?.info as Record<string, unknown> | undefined) ?? info ?? {}
  const entries = Object.entries(src)
    .filter(([, v]) => typeof v !== "object")
    .slice(0, 9)
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
      {entries.map(([k, v]) => (
        <div key={k} className="rounded-lg border border-border bg-card p-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {k}
          </div>
          <div className="truncate text-sm font-medium">{String(v)}</div>
        </div>
      ))}
    </div>
  )
}
