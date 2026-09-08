"use client"

import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { AlertTriangle, Bell, RefreshCw } from "lucide-react"
import { Badge } from "#/components/reui/badge"
import { Button } from "#/components/ui/button"
import { POLL } from "#/lib/poll"
import { Input } from "#/components/ui/input"
import { Label } from "#/components/ui/label"
import { Checkbox } from "#/components/ui/checkbox"
import { Modal } from "./Modal"

type HealthPoint = {
  ts: number
  ok: boolean
  latencyMs: number | null
  error: string | null
}

type SummaryNode = {
  id: string
  name: string
  status: string
  version: string | null
  latencyMs: number | null
  lastCheckTs: number | null
  error: string | null
  history: HealthPoint[]
  serversDown: number
  serversTotal: number
}

type HealthSummary = {
  checkedAt: number
  nodes: SummaryNode[]
  totals: { up: number; down: number; unknown: number; serversDown: number }
}

function LatencyBars({ history }: { history: HealthPoint[] }) {
  if (history.length === 0) {
    return <span className="text-xs text-muted-foreground">no data</span>
  }
  const points = history.slice(-30)
  const maxLatency = Math.max(...points.map((p) => p.latencyMs ?? 0), 1)
  return (
    <div className="flex h-8 items-end gap-[2px]" aria-label="latency history">
      {points.map((p) => (
        <div
          key={p.ts}
          title={
            p.ok
              ? `${new Date(p.ts).toLocaleTimeString()} — ${p.latencyMs ?? "?"} ms`
              : `${new Date(p.ts).toLocaleTimeString()} — ${p.error ?? "down"}`
          }
          className={[
            "w-[5px] rounded-sm",
            p.ok ? "bg-success/70" : "bg-destructive/80",
          ].join(" ")}
          style={{
            height: `${p.ok ? Math.max(15, ((p.latencyMs ?? 0) / maxLatency) * 100) : 100}%`,
          }}
        />
      ))}
    </div>
  )
}

type SmtpSettingsUi = {
  host: string
  port: number
  secure: boolean
  username: string
  password: string
  fromAddr: string
  toAddrs: string
  enabled: boolean
  hasPassword?: boolean
}

function AlertSettingsModal({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState("")
  const [enabled, setEnabled] = useState(false)
  const [smtp, setSmtp] = useState<SmtpSettingsUi>({
    host: "",
    port: 587,
    secure: false,
    username: "",
    password: "",
    fromAddr: "",
    toAddrs: "",
    enabled: false,
  })
  const [loaded, setLoaded] = useState(false)
  const [pending, setPending] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/alerts/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          j: {
            webhookUrl: string
            enabled: boolean
            smtp?: SmtpSettingsUi
          } | null,
        ) => {
          if (j) {
            setUrl(j.webhookUrl)
            setEnabled(j.enabled)
            if (j.smtp) setSmtp({ ...smtp, ...j.smtp })
          }
          setLoaded(true)
        },
      )
      .catch(() => setLoaded(true))
  }, [])

  const save = async (testOnly?: "webhook" | "smtp") => {
    setPending(true)
    setMsg(null)
    try {
      if (testOnly) {
        const res = await fetch("/api/alerts/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            testOnly === "smtp"
              ? { channel: "smtp" }
              : { channel: "webhook", webhookUrl: url },
          ),
        })
        const j = await res.json().catch(() => ({}))
        setMsg(
          j.ok
            ? testOnly === "smtp"
              ? "Test email sent."
              : "Test payload sent."
            : `Test failed: ${j.error ?? res.status}`,
        )
        return
      }
      const res = await fetch("/api/alerts/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          webhookUrl: url,
          enabled,
          smtp: {
            host: smtp.host,
            port: smtp.port,
            secure: smtp.secure,
            username: smtp.username,
            password: smtp.password,
            fromAddr: smtp.fromAddr,
            toAddrs: smtp.toAddrs,
            enabled: smtp.enabled,
          },
        }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error ?? "save failed")
      setMsg("Settings saved.")
    } catch (e) {
      setMsg((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  const sm = (patch: Partial<SmtpSettingsUi>) => setSmtp({ ...smtp, ...patch })

  return (
    <Modal open onClose={onClose} title="Alert notifications">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Webhooks and/or emails are sent when a node transitions down or
          recovers (5-minute cooldown). Works with Slack/Discord/generic JSON
          hooks and any SMTP server.
        </p>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">
            Webhook URL
          </Label>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://hooks.example.com/..."
            aria-label="webhook url"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={enabled}
            onCheckedChange={(v) => setEnabled(v === true)}
          />
          Enable webhook alerts
        </label>

        <div className="mt-1 border-t border-border pt-3">
          <label className="mb-2 flex items-center gap-2 text-sm">
            <Checkbox
              checked={smtp.enabled}
              onCheckedChange={(v) => sm({ enabled: v === true })}
            />
            Enable email alerts (SMTP)
          </label>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">SMTP host</Label>
              <Input
                value={smtp.host}
                onChange={(e) => sm({ host: e.target.value })}
                placeholder="smtp.example.com"
                aria-label="smtp host"
              />
            </div>
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">Port</Label>
              <Input
                type="number"
                value={smtp.port}
                onChange={(e) => sm({ port: Number(e.target.value) || 587 })}
                aria-label="smtp port"
              />
            </div>
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">Username</Label>
              <Input
                value={smtp.username}
                onChange={(e) => sm({ username: e.target.value })}
                aria-label="smtp username"
              />
            </div>
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">
                Password{smtp.hasPassword ? " (saved)" : ""}
              </Label>
              <Input
                type="password"
                value={smtp.password}
                onChange={(e) => sm({ password: e.target.value })}
                placeholder={smtp.hasPassword ? "••••••••" : ""}
                aria-label="smtp password"
              />
            </div>
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">From</Label>
              <Input
                value={smtp.fromAddr}
                onChange={(e) => sm({ fromAddr: e.target.value })}
                placeholder="alerts@example.com"
                aria-label="smtp from"
              />
            </div>
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">
                Recipients (comma-separated)
              </Label>
              <Input
                value={smtp.toAddrs}
                onChange={(e) => sm({ toAddrs: e.target.value })}
                placeholder="oncall@example.com, ops@example.com"
                aria-label="smtp recipients"
              />
            </div>
          </div>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <Checkbox
              checked={smtp.secure}
              onCheckedChange={(v) => sm({ secure: v === true })}
            />
            Implicit TLS (port 465); otherwise STARTTLS when offered
          </label>
        </div>

        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || !loaded || !url}
            onClick={() => save("webhook")}
          >
            Test webhook
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || !loaded || !smtp.enabled || !smtp.host}
            onClick={() => save("smtp")}
          >
            Test email
          </Button>
          <Button
            size="sm"
            disabled={pending || !loaded || (enabled && !url && !smtp.enabled)}
            onClick={() => save()}
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function FleetHealth() {
  const [alertOpen, setAlertOpen] = useState(false)
  const historyQ = useQuery({
    queryKey: ["alert-history"],
    queryFn: async (): Promise<
      { id: string; ts: number; channel: string; kind: string; subject: string; delivered: boolean }[]
    > => {
      const res = await fetch("/api/alerts/history?limit=10")
      if (!res.ok) throw new Error("failed to load history")
      return res.json()
    },
    refetchInterval: POLL.NODES,
  })
  const q = useQuery({
    queryKey: ["health-summary"],
    queryFn: async (): Promise<HealthSummary> => {
      const res = await fetch("/api/health/summary")
      if (!res.ok) throw new Error("failed to load health summary")
      return res.json()
    },
    refetchInterval: POLL.HEALTH,
  })

  const refresh = () => q.refetch()

  const data = q.data
  const alerts: { severity: "error" | "warn"; text: string }[] = []
  for (const n of data?.nodes ?? []) {
    if (n.status === "down") {
      alerts.push({ severity: "error", text: `Node "${n.name}" is down` })
    }
    if (n.serversDown > 0) {
      alerts.push({
        severity: "warn",
        text: `${n.serversDown}/${n.serversTotal} servers not UP on "${n.name}"`,
      })
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Fleet health</h2>
        <div className="flex items-center gap-2">
          {data?.totals.serversDown ? (
            <Badge variant="warning">{data.totals.serversDown} servers down</Badge>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setAlertOpen(true)}
            aria-label="alert settings"
          >
            <Bell className="h-3.5 w-3.5" />
            Alerts
          </Button>
          <Button size="xs" variant="outline" onClick={refresh} disabled={q.isFetching}>
            <RefreshCw className={"h-3 w-3 " + (q.isFetching ? "animate-spin" : "")} />
            Refresh
          </Button>
        </div>
      </div>

      {alertOpen && <AlertSettingsModal onClose={() => setAlertOpen(false)} />}

      {historyQ.data && historyQ.data.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Recent notifications
          </div>
          <div className="max-h-44 space-y-1 overflow-auto">
            {historyQ.data.map((h) => (
              <div key={h.id} className="flex items-center gap-2 text-xs">
                <Badge variant={h.delivered ? "info" : "destructive"}>
                  {h.channel}
                </Badge>
                <span className="min-w-0 flex-1 truncate" title={h.subject}>
                  {h.subject}
                </span>
                <span className="whitespace-nowrap text-muted-foreground">
                  {new Date(h.ts).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {q.isLoading && <p className="text-muted-foreground">Checking nodes…</p>}

      {data && data.nodes.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No nodes registered yet — health monitoring starts once you register a
          node.
        </p>
      )}

      {alerts.length > 0 && (
        <div className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          {alerts.map((a) => (
            <div key={a.text} className="flex items-center gap-2 text-sm">
              <AlertTriangle
                className={
                  a.severity === "error"
                    ? "h-4 w-4 text-destructive"
                    : "h-4 w-4 text-yellow-500"
                }
              />
              {a.text}
            </div>
          ))}
        </div>
      )}

      {data && data.nodes.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Node</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Latency</th>
                <th className="px-3 py-2">Trend (last checks)</th>
                <th className="px-3 py-2">Servers</th>
              </tr>
            </thead>
            <tbody>
              {data.nodes.map((n) => (
                <tr key={n.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <span className="font-medium">{n.name}</span>
                    {n.version && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        HAProxy {n.version}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      variant={
                        n.status === "up"
                          ? "success"
                          : n.status === "down"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {n.status}
                    </Badge>
                    {n.error && (
                      <div className="mt-1 text-xs text-destructive">{n.error}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {n.latencyMs != null ? `${n.latencyMs} ms` : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <LatencyBars history={n.history} />
                  </td>
                  <td className="px-3 py-2">
                    {n.serversTotal === 0 ? (
                      "—"
                    ) : n.serversDown === 0 ? (
                      <span className="text-success">
                        {n.serversTotal}/{n.serversTotal} UP
                      </span>
                    ) : (
                      <span className="text-destructive">
                        {n.serversTotal - n.serversDown}/{n.serversTotal} UP
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
