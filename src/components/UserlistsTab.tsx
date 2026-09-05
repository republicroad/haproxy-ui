"use client"

import { useEffect, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "#/components/ui/button"
import { Input } from "#/components/ui/input"
import { Label } from "#/components/ui/label"
import { ConfirmDialog } from "./ConfirmDialog"
import { dpGet, dpPost, dpDelete, withTransaction } from "#/lib/dataplane/client"

type HAUser = { username: string; password?: string; inactive?: boolean }
type Userlist = { name: string; users?: HAUser[] }

export function UserlistsTab({ nodeId }: { nodeId: string }) {
  const qc = useQueryClient()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const [selected, setSelected] = useState("")
  const [newList, setNewList] = useState("")
  const [deletingList, setDeletingList] = useState<string | null>(null)
  const [newUser, setNewUser] = useState({ username: "", password: "" })
  const [deletingUser, setDeletingUser] = useState<{ list: string; user: string } | null>(null)

  const listsQ = useQuery({
    queryKey: ["userlists", nodeId],
    queryFn: () => dpGet<Userlist[]>(nodeId, "services/haproxy/configuration/userlists"),
    enabled: mounted,
  })
  const lists = listsQ.data ?? []
  const effective = selected || lists[0]?.name || ""

  const usersQ = useQuery({
    queryKey: ["userlist-users", nodeId, effective],
    queryFn: () =>
      dpGet<HAUser[]>(
        nodeId,
        `services/haproxy/configuration/userlists/${encodeURIComponent(effective)}/users`,
      ),
    enabled: mounted && Boolean(effective),
  })
  const users = usersQ.data ?? []

  const reload = () => {
    qc.invalidateQueries({ queryKey: ["userlists", nodeId] })
    qc.invalidateQueries({ queryKey: ["userlist-users", nodeId, effective] })
  }

  const createList = async () => {
    if (!newList.trim()) return
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await dpPost(
            nodeId,
            `services/haproxy/configuration/userlists?transaction_id=${tx}`,
            { name: newList.trim() },
            tx,
          )
        },
        { kind: "create", resource: "userlist", target: newList.trim(), payload: { name: newList.trim() } },
      )
      toast.success(`Userlist "${newList.trim()}" created`)
      setSelected(newList.trim())
      setNewList("")
      reload()
    } catch (e) {
      toast.error("Failed to create userlist", { description: (e as Error).message })
    }
  }

  const deleteList = async (name: string) => {
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await dpDelete(
            nodeId,
            `services/haproxy/configuration/userlists/${encodeURIComponent(name)}?transaction_id=${tx}`,
            tx,
          )
        },
        { kind: "delete", resource: "userlist", target: name, payload: { name } },
      )
      toast.success(`Userlist "${name}" deleted`)
      if (effective === name) setSelected("")
      setDeletingList(null)
      reload()
    } catch (e) {
      toast.error("Failed to delete userlist", { description: (e as Error).message })
      setDeletingList(null)
    }
  }

  const addUser = async () => {
    if (!newUser.username || !newUser.password) return
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await dpPost(
            nodeId,
            `services/haproxy/configuration/userlists/${encodeURIComponent(effective)}/users?transaction_id=${tx}`,
            { username: newUser.username, password: newUser.password, inactive: false },
            tx,
          )
        },
        {
          kind: "create",
          resource: "user",
          target: newUser.username,
          parent: effective,
          payload: { username: newUser.username },
        },
      )
      toast.success(`User "${newUser.username}" added to ${effective}`)
      setNewUser({ username: "", password: "" })
      reload()
    } catch (e) {
      toast.error("Failed to add user", { description: (e as Error).message })
    }
  }

  const deleteUser = async (list: string, username: string) => {
    try {
      await withTransaction(
        nodeId,
        async (tx) => {
          await dpDelete(
            nodeId,
            `services/haproxy/configuration/userlists/${encodeURIComponent(list)}/users/${encodeURIComponent(username)}?transaction_id=${tx}`,
            tx,
          )
        },
        { kind: "delete", resource: "user", target: username, parent: list },
      )
      toast.success(`User "${username}" removed`)
      setDeletingUser(null)
      reload()
    } catch (e) {
      toast.error("Failed to remove user", { description: (e as Error).message })
      setDeletingUser(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Userlist</Label>
          <div className="flex gap-2">
            <select
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
              value={effective}
              onChange={(e) => setSelected(e.target.value)}
              aria-label="userlist"
            >
              {lists.length === 0 && <option value="">no userlists</option>}
              {lists.map((l) => (
                <option key={l.name} value={l.name}>
                  {l.name} ({l.users?.length ?? 0} users)
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex items-end gap-2">
          <Input
            value={newList}
            onChange={(e) => setNewList(e.target.value)}
            placeholder="new list name"
            className="w-44"
            aria-label="new userlist name"
          />
          <Button size="sm" variant="outline" onClick={createList} disabled={!newList.trim()}>
            Create list
          </Button>
          {effective && (
            <Button size="sm" variant="destructive" onClick={() => setDeletingList(effective)}>
              Delete list
            </Button>
          )}
        </div>
      </div>

      {!effective ? (
        <p className="text-sm text-muted-foreground">
          No userlists on this node. Create one to provide Basic Auth users
          (referenced via `auth userlist_name` rules or `acl ... http_auth(...)`).
        </p>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Username</th>
                  <th className="px-3 py-2">State</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {users.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-3 text-muted-foreground">
                      No users in this list.
                    </td>
                  </tr>
                )}
                {users.map((u) => (
                  <tr key={u.username} className="border-t border-border">
                    <td className="px-3 py-2 font-mono text-xs">{u.username}</td>
                    <td className="px-3 py-2">
                      {u.inactive ? "inactive" : "active"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="xs"
                        variant="destructive"
                        onClick={() => setDeletingUser({ list: effective, user: u.username })}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-lg border border-border p-3">
            <div className="mb-2 text-sm font-medium">Add user to {effective}</div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={newUser.username}
                onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                placeholder="username"
                className="w-40"
                aria-label="userlist username"
              />
              <Input
                type="password"
                value={newUser.password}
                onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                placeholder="password"
                className="w-40"
                aria-label="userlist password"
              />
              <Button
                onClick={addUser}
                disabled={!newUser.username || !newUser.password}
              >
                Add user
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Passwords are stored by HAProxy (plain or crypted per config);
              applied in a validated transaction and recorded in history.
            </p>
          </div>
        </>
      )}

      <ConfirmDialog
        open={Boolean(deletingList)}
        title="Delete userlist"
        message={`Delete userlist "${deletingList}"? Frontends referencing it (auth rules) will fail validation on next reload.`}
        confirmLabel="Delete"
        pending={false}
        onCancel={() => setDeletingList(null)}
        onConfirm={() => deletingList && deleteList(deletingList)}
      />
      <ConfirmDialog
        open={Boolean(deletingUser)}
        title="Remove user"
        message={`Remove "${deletingUser?.user}" from "${deletingUser?.list}"?`}
        confirmLabel="Remove"
        pending={false}
        onCancel={() => setDeletingUser(null)}
        onConfirm={() => deletingUser && deleteUser(deletingUser.list, deletingUser.user)}
      />
    </div>
  )
}
