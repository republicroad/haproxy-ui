"use client"

import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { Label } from "#/components/ui/label"
import { Badge } from "#/components/reui/badge"
import { ConfirmDialog } from "./ConfirmDialog"
import { GridSearchInput } from "./GridSearchInput"

type CertInfo = {
  name: string
  description: string
  subject: string | null
  issuer: string | null
  validFrom: string | null
  validTo: string | null
}

function expiryState(validTo: string | null): { tone: "success" | "warning" | "destructive" | "secondary"; label: string } {
  if (!validTo) return { tone: "secondary", label: "unknown" }
  const ms = new Date(validTo).getTime() - Date.now()
  const days = Math.floor(ms / 86_400_000)
  if (ms < 0) return { tone: "destructive", label: `expired ${-days}d ago` }
  if (days <= 30) return { tone: "warning", label: `${days}d left` }
  return { tone: "success", label: `${days}d left` }
}

export function CertificatesTab({ nodeId }: { nodeId: string }) {
  const qc = useQueryClient()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const [search, setSearch] = useState("")
  const [uploadOpen, setUploadOpen] = useState(false)
  const [form, setForm] = useState({ name: "", pem: "" })
  const [deleting, setDeleting] = useState<string | null>(null)

  const q = useQuery({
    queryKey: ["certs", nodeId],
    queryFn: async (): Promise<CertInfo[]> => {
      const res = await fetch(`/api/nodes/${nodeId}/certs`)
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error ?? "failed to load certificates")
      return j.certs
    },
    enabled: mounted,
    refetchInterval: 60_000,
  })
  const certs = (q.data ?? []).filter((c) =>
    search ? c.name.toLowerCase().includes(search.toLowerCase()) : true,
  )

  const uploadMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/nodes/${nodeId}/certs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error ?? "upload failed")
      return j
    },
    onSuccess: () => {
      toast.success(`Certificate "${form.name}" uploaded`)
      setUploadOpen(false)
      setForm({ name: "", pem: "" })
      qc.invalidateQueries({ queryKey: ["certs", nodeId] })
    },
    onError: (e) =>
      toast.error("Upload failed", { description: (e as Error).message }),
  })

  const deleteMut = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch(`/api/nodes/${nodeId}/certs?name=${encodeURIComponent(name)}`, {
        method: "DELETE",
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error ?? "delete failed")
    },
    onSuccess: (_, name) => {
      toast.success(`Certificate "${name}" deleted`)
      setDeleting(null)
      qc.invalidateQueries({ queryKey: ["certs", nodeId] })
    },
    onError: (e) =>
      toast.error("Delete failed", { description: (e as Error).message }),
  })

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <GridSearchInput value={search} onChange={setSearch} placeholder="Filter certificates…" />
        <Button size="sm" onClick={() => setUploadOpen(true)}>Upload certificate</Button>
      </div>

      {q.isLoading && <p className="text-muted-foreground">Loading…</p>}
      {q.isError && (
        <p className="text-destructive">Cannot read certificates: {(q.error as Error).message}</p>
      )}
      {q.data && certs.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No certificates stored on this node.
        </p>
      )}
      {certs.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Subject</th>
                <th className="px-3 py-2">Issuer</th>
                <th className="px-3 py-2">Valid to</th>
                <th className="px-3 py-2">Expiry</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {certs.map((c) => {
                const ex = expiryState(c.validTo)
                return (
                  <tr key={c.name} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs font-medium">{c.name}</td>
                    <td className="px-3 py-2 max-w-48 truncate" title={c.subject ?? ""}>
                      {c.subject ?? "—"}
                    </td>
                    <td className="px-3 py-2 max-w-40 truncate" title={c.issuer ?? ""}>
                      {c.issuer ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      {c.validTo ? new Date(c.validTo).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={ex.tone}>{ex.label}</Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="xs"
                        variant="destructive"
                        disabled={deleteMut.isPending}
                        onClick={() => setDeleting(c.name)}
                      >
                        Delete
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {uploadOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-lg space-y-3 rounded-lg border border-border bg-card p-5 shadow-lg">
            <div className="text-lg font-semibold">Upload certificate</div>
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">
                File name (stored on the node)
              </Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="example.pem"
                aria-label="certificate file name"
              />
            </div>
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">
                PEM content (certificate + key)
              </Label>
              <textarea
                className="h-40 w-full rounded-md border border-border bg-background p-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
                value={form.pem}
                onChange={(e) => setForm({ ...form, pem: e.target.value })}
                placeholder={"-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"}
                aria-label="pem content"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setUploadOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={uploadMut.isPending || !form.name || !form.pem}
                onClick={() => uploadMut.mutate()}
              >
                {uploadMut.isPending ? "Uploading…" : "Upload"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete certificate"
        message={`Delete "${deleting}" from the node's storage? Frontends referencing it will break on next reload.`}
        confirmLabel="Delete"
        pending={deleteMut.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && deleteMut.mutate(deleting)}
      />
    </div>
  )
}
