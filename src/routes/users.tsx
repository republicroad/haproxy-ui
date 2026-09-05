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

type UserRow = {
  username: string
  role: "admin" | "viewer"
  createdAt: number
}

async function fetchMe(): Promise<{ username: string | null; role: string | null }> {
  const res = await fetch("/api/auth/status")
  if (!res.ok) throw new Error("failed to load auth status")
  return res.json()
}

function UsersPage() {
  const qc = useQueryClient()
  const [me, setMe] = useState<{ username: string | null; role: string | null } | null>(null)
  const [form, setForm] = useState({ username: "", password: "", role: "viewer" })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [deleting, setDeleting] = useState<UserRow | null>(null)
  const [resetting, setResetting] = useState<UserRow | null>(null)
  const [newPass, setNewPass] = useState("")

  useEffect(() => {
    fetchMe().then(setMe).catch(() => setMe({ username: null, role: null }))
  }, [])

  const is_Admin = me?.role === "admin"

  const q = useQuery({
    queryKey: ["users"],
    queryFn: async (): Promise<UserRow[]> => {
      const res = await fetch("/api/users")
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error ?? "failed to load users")
      return j
    },
    enabled: is_Admin,
  })
  const users = q.data ?? []

  const refresh = () => qc.invalidateQueries({ queryKey: ["users"] })

  const createMut = async () => {
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) {
      if (j.fields) setErrors(j.fields)
      toast.error(j.error ?? "create failed")
      return
    }
    toast.success(`User "${form.username}" created`)
    setForm({ username: "", password: "", role: "viewer" })
    setErrors({})
    refresh()
  }

  const deleteMut = async (username: string) => {
    const res = await fetch(`/api/users/${username}`, { method: "DELETE" })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(j.error ?? "delete failed")
      return
    }
    toast.success(`User "${username}" deleted`)
    setDeleting(null)
    refresh()
  }

  const resetMut = async () => {
    if (!resetting) return
    const res = await fetch(`/api/users/${resetting.username}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: newPass }),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(j.error ?? "reset failed")
      return
    }
    toast.success(`Password reset for "${resetting.username}"`)
    setResetting(null)
    setNewPass("")
  }

  const roleMut = async (username: string, role: "admin" | "viewer") => {
    const res = await fetch(`/api/users/${username}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    })
    const j = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(j.error ?? "role change failed")
      refresh()
      return
    }
    toast.success(`Role updated for "${username}"`)
    refresh()
  }

  if (me && !is_Admin) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <h1 className="text-2xl font-bold">Users</h1>
        <p className="text-muted-foreground">Admin access required.</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Users</h1>
        <p className="text-muted-foreground">
          Accounts for the web UI. Admins manage configuration; viewers are
          read-only.
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Username</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {q.isLoading && (
              <tr>
                <td colSpan={3} className="px-3 py-3 text-muted-foreground">
                  Loading…
                </td>
              </tr>
            )}
            {users.map((u) => (
              <tr key={u.username} className="border-t border-border">
                <td className="px-3 py-2 font-medium">
                  {u.username}
                  {u.username === me?.username && (
                    <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  <Badge variant={u.role === "admin" ? "default" : "secondary"}>
                    {u.role}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-1">
                    <Select
                      value={u.role}
                      onValueChange={(v) => v && roleMut(u.username, v as "admin" | "viewer")}
                    >
                      <SelectTrigger className="h-7 w-[110px]" aria-label={`role for ${u.username}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">admin</SelectItem>
                        <SelectItem value="viewer">viewer</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        setResetting(u)
                        setNewPass("")
                      }}
                    >
                      Reset pass
                    </Button>
                    <Button
                      size="xs"
                      variant="destructive"
                      disabled={u.username === me?.username}
                      onClick={() => setDeleting(u)}
                    >
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {!q.isLoading && users.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-3 text-muted-foreground">
                  No database users. The env single-user (if configured) is active.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-border p-4">
        <div className="mb-3 text-sm font-semibold">Create user</div>
        <div className="flex flex-wrap items-start gap-2">
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Username</Label>
            <Input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              className="w-44"
              aria-label="username"
            />
            {errors.username && <p className="text-xs text-destructive">{errors.username}</p>}
          </div>
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Password</Label>
            <Input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="w-44"
              aria-label="password"
            />
            {errors.password && <p className="text-xs text-destructive">{errors.password}</p>}
          </div>
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">Role</Label>
            <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v ?? "viewer" })}>
              <SelectTrigger className="w-[110px]" aria-label="role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">viewer</SelectItem>
                <SelectItem value="admin">admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button onClick={createMut} className="mt-5">
            Create user
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete user"
        message={`Remove "${deleting?.username}"? They will no longer be able to sign in.`}
        confirmLabel="Delete"
        pending={false}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && deleteMut(deleting.username)}
      />

      {resetting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-sm space-y-3 rounded-lg border border-border bg-card p-5 shadow-lg">
            <div className="font-semibold">Reset password for {resetting.username}</div>
            <Input
              type="password"
              value={newPass}
              onChange={(e) => setNewPass(e.target.value)}
              placeholder="new password (min 6 chars)"
              aria-label="new password"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setResetting(null)}>
                Cancel
              </Button>
              <Button disabled={newPass.length < 6} onClick={resetMut}>
                Reset
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export const Route = createFileRoute("/users")({ component: UsersPage })
