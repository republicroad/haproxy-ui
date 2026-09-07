"use client"

import { useEffect, useState } from "react"
import { Badge } from "#/components/reui/badge"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { Label } from "#/components/ui/label"
import { Checkbox } from "#/components/ui/checkbox"
import { Modal } from "#/components/Modal"

type RunRow = {
  ts: number
  action: string
  toVersion: string | null
  result: string
  actor: string | null
}

/**
 * Binary-upgrade orchestration around the operator's (ssh/Ansible) swap:
 * prepare = config snapshot + optional server drain; verify = re-probe
 * the runtime version and check it against the target.
 */
export function UpgradeModal({
  nodeId,
  currentVersion,
  onClose,
}: {
  nodeId: string
  currentVersion: string | null
  onClose: () => void
}) {
  const [target, setTarget] = useState("")
  const [drain, setDrain] = useState(false)
  const [pending, setPending] = useState<"prepare" | "verify" | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [runs, setRuns] = useState<RunRow[]>([])

  const loadRuns = () =>
    fetch(`/api/nodes/${nodeId}/upgrade`)
      .then((r) => (r.ok ? r.json() : { runs: [] }))
      .then((j: { runs: RunRow[] }) => setRuns(j.runs))
      .catch(() => {})

  useEffect(() => {
    setTarget(localStorage.getItem("hui-target-haproxy") ?? "")
    void loadRuns()
  }, [])

  const act = async (action: "prepare" | "verify") => {
    setPending(action)
    setMsg(null)
    try {
      if (action === "verify" && target.trim()) {
        localStorage.setItem("hui-target-haproxy", target.trim())
      }
      const res = await fetch(`/api/nodes/${nodeId}/upgrade`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, drain, targetVersion: target.trim() || undefined }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error ?? `${action} failed`)
      if (action === "prepare") {
        setMsg(
          j.snapshot
            ? `Snapshot saved (${j.snapshot.frontends} frontends, ${j.snapshot.backends} backends). Swap the binary on the host, then run Verify.`
            : `Snapshot failed: ${j.snapshotError}. Verify aborted drains.`,
        )
      } else {
        setMsg(
          j.error
            ? `Node unreachable: ${j.error}`
            : j.targetMatch === null
              ? `Running version: ${j.version}`
              : j.targetMatch
                ? `Upgrade verified: ${j.version} matches target.`
                : `Version mismatch: running ${j.version}, target ${target}.`,
        )
      }
      await loadRuns()
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setPending(null)
    }
  }

  return (
    <Modal open onClose={onClose} title="HAProxy upgrade">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          dataplaneapi cannot replace the binary itself. This wizard drives
          the safe sequence: snapshot (rollback artifact) → optional drain →
          you swap the binary on the host → verify the running version.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Current version</Label>
            <Input value={currentVersion ?? "unknown"} disabled aria-label="current version" />
          </div>
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Target version</Label>
            <Input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="3.3.0"
              aria-label="target version"
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={drain} onCheckedChange={(v) => setDrain(v === true)} />
          Drain all servers on prepare (traffic shift — only if peers take over)
        </label>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={pending !== null}
            onClick={() => void act("prepare")}
          >
            {pending === "prepare" ? "Preparing…" : "1 · Prepare"}
          </Button>
          <Button
            size="sm"
            disabled={pending !== null}
            onClick={() => void act("verify")}
          >
            {pending === "verify" ? "Verifying…" : "2 · Verify"}
          </Button>
        </div>
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

        {runs.length > 0 && (
          <div className="mt-1 border-t border-border pt-2">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recent runs
            </div>
            <div className="max-h-40 space-y-1 overflow-auto">
              {runs.map((r, i) => {
                let outcome = ""
                try {
                  const j = JSON.parse(r.result) as Record<string, unknown>
                  outcome =
                    r.action === "verify"
                      ? `${j.version ?? "?"}${j.targetMatch === true ? " ✓" : j.targetMatch === false ? " (mismatch)" : ""}`
                      : j.snapshot
                        ? `snapshot ok`
                        : `snapshot failed`
                } catch {
                  outcome = r.result
                }
                return (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">
                      {new Date(r.ts).toLocaleString()} · {r.action}
                    </span>
                    <Badge variant={outcome.includes("✓") || outcome === "snapshot ok" ? "success" : "secondary"}>
                      {outcome}
                    </Badge>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
