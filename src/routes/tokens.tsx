import { createFileRoute } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { Label } from "#/components/ui/label"
import { Badge } from "#/components/reui/badge"
import { ConfirmDialog } from "#/components/ConfirmDialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select"

type TokenRow = {
  id: string
  name: string
  role: "admin" | "viewer"
  scope: string
  createdAt: number
  lastUsed: number | null
}

function scopeLabel(scope: string): string {
  if (scope === "readonly") return "read-only"
  if (scope.startsWith("group:")) return `group ${scope.slice(6)}`
  return "full access"
}

function TokensPage() {
  const qc = useQueryClient()
  const [me, setMe] = useState<{ role: string | null } | null>(null)
  const [form, setForm] = useState({
    name: "",
    role: "viewer",
    scopeKind: "all",
    group: "",
  })
  const [minted, setMinted] = useState<{ name: string; token: string } | null>(null)
  const [deleting, setDeleting] = useState<TokenRow | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => r.json())
      .then((j: { enabled?: boolean; role?: string }) =>
        setMe({ role: j.enabled ? (j.role ?? null) : "admin" }),
      )
      .catch(() => setMe({ role: null }))
  }, [])
  const isAdmin = me?.role === "admin"

  const q = useQuery({
    queryKey: ["tokens"],
    queryFn: async (): Promise<TokenRow[]> => {
      const res = await fetch("/api/tokens")
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error ?? "failed to load tokens")
      return j
    },
    enabled: isAdmin,
  })
  const tokens = q.data ?? []
  const refresh = () => qc.invalidateQueries({ queryKey: ["tokens"] })

  const createMut = async () => {
    const res = await fetch("/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(j.error ?? "create failed")
      return
    }
    setMinted({ name: j.name, token: j.token })
    setForm({ name: "", role: "viewer", scopeKind: "all", group: "" })
    refresh()
  }

  const deleteMut = async (id: string) => {
    const res = await fetch(`/api/tokens/${id}`, { method: "DELETE" })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      toast.error(j.error ?? "revoke failed")
      return
    }
    toast.success("Token revoked")
    setDeleting(null)
    refresh()
  }

  if (me && !isAdmin) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <h1 className="text-2xl font-bold">API tokens</h1>
        <p className="text-muted-foreground">Admin access required.</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">API tokens</h1>
        <p className="text-muted-foreground">
          Bearer tokens for automation (curl, CI, scripts). Send as
          <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">
            Authorization: Bearer &lt;token&gt;
          </code>
          . Only the hash is stored — the plaintext is shown once. The full
          API surface is documented in{" "}
          <a
            href="/api/openapi"
            target="_blank"
            rel="noreferrer"
            className="underline hover:text-foreground"
          >
            /api/openapi
          </a>
          .
        </p>
      </div>

      {minted && (
        <div className="space-y-2 rounded-lg border border-success/50 bg-success/5 p-3">
          <div className="text-sm font-medium">Token created: {minted.name}</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-muted px-2 py-1 font-mono text-xs">
              {minted.token}
            </code>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                navigator.clipboard.writeText(minted.token).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                })
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-xs text-destructive">
            Copy it now — it cannot be retrieved again.
          </p>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Scope</th>
              <th className="px-3 py-2">Last used</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading && (
              <tr>
                <td colSpan={4} className="px-3 py-3 text-muted-foreground">
                  Loading…
                </td>
              </tr>
            )}
            {tokens.map((t) => (
              <tr key={t.id} className="border-t border-border">
                <td className="px-3 py-2 font-medium">{t.name}</td>
                <td className="px-3 py-2">
                  <Badge variant={t.role === "admin" ? "default" : "secondary"}>
                    {t.role}
                  </Badge>
                </td>
                <td className="px-3 py-2">
                  <Badge variant={t.scope === "all" ? "outline" : "info"}>
                    {scopeLabel(t.scope)}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {t.lastUsed ? new Date(t.lastUsed).toLocaleString() : "never"}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button size="xs" variant="destructive" onClick={() => setDeleting(t)}>
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
            {!q.isLoading && tokens.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-3 text-muted-foreground">
                  No API tokens yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-border p-4">
        <div className="mb-3 text-sm font-semibold">Create token</div>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Name</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="ci-pipeline"
              className="w-44"
              aria-label="token name"
            />
          </div>
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Role</Label>
            <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v ?? "viewer" })}>
              <SelectTrigger className="w-[110px]" aria-label="token role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">viewer</SelectItem>
                <SelectItem value="admin">admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Scope</Label>
            <Select
              value={form.scopeKind}
              onValueChange={(v) => setForm({ ...form, scopeKind: v ?? "all" })}
            >
              <SelectTrigger className="w-[150px]" aria-label="token scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">full access</SelectItem>
                <SelectItem value="readonly">read-only</SelectItem>
                <SelectItem value="group">node group…</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {form.scopeKind === "group" && (
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">Group</Label>
              <Input
                value={form.group}
                onChange={(e) => setForm({ ...form, group: e.target.value })}
                placeholder="edge"
                className="w-36"
                aria-label="token group"
              />
            </div>
          )}
          <Button
            onClick={createMut}
            disabled={!form.name || (form.scopeKind === "group" && !form.group.trim())}
          >
            Create token
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Read-only tokens cannot perform any write, group tokens act like an
          admin but only for nodes in the given group.
        </p>
      </div>

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Revoke token"
        message={`Revoke "${deleting?.name}"? Clients using it will immediately lose access.`}
        confirmLabel="Revoke"
        pending={false}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && deleteMut(deleting.id)}
      />
    </div>
  )
}

export const Route = createFileRoute("/tokens")({ component: TokensPage })
