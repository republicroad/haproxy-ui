import { Link, useLocation, useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  Server,
  LayoutDashboard,
  Boxes,
  LogOut,
  Users as UsersIcon,
} from "lucide-react"

function LogoutButton() {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => {})
        toast.success("Signed out")
        navigate({ to: "/login", search: { from: undefined } })
      }}
      className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <LogOut className="h-4 w-4" />
      Sign out
    </button>
  )
}

export function Sidebar() {
  const location = useLocation()
  const [authEnabled, setAuthEnabled] = useState(false)
  const [role, setRole] = useState<string | null>(null)
  useEffect(() => {
    fetch("/api/auth/status")
      .then((r) => (r.ok ? r.json() : { enabled: false, role: "admin" }))
      .then((j: { enabled?: boolean; role?: string }) => {
        setAuthEnabled(Boolean(j.enabled))
        setRole(j.enabled ? (j.role ?? null) : "admin")
      })
      .catch(() => {
        setAuthEnabled(false)
        setRole(null)
      })
  }, [])

  const nav = [
    { to: "/" as const, label: "Overview", icon: LayoutDashboard },
    { to: "/nodes" as const, label: "Nodes", icon: Boxes },
    ...(authEnabled && role === "admin"
      ? [{ to: "/users" as const, label: "Users", icon: UsersIcon }]
      : []),
  ]

  return (
    <aside className="w-60 shrink-0 border-r border-border bg-card/40 p-4 hidden md:flex md:flex-col">
      <div className="flex items-center gap-2 px-2 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Server className="h-4 w-4" />
        </div>
        <div className="font-semibold leading-tight">
          HAProxy UI
          <div className="text-[10px] font-normal text-muted-foreground">
            open-source Fusion
          </div>
        </div>
      </div>
      <nav className="mt-4 flex flex-1 flex-col gap-1">
        {nav.map((item) => {
          const active =
            item.to === "/"
              ? location.pathname === "/"
              : location.pathname.startsWith(item.to)
          const Icon = item.icon
          return (
            <Link
              key={item.to}
              to={item.to}
              className={[
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              ].join(" ")}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          )
        })}
      </nav>
      {authEnabled && (
        <div className="mt-2 border-t border-border pt-2">
          <LogoutButton />
        </div>
      )}
    </aside>
  )
}
