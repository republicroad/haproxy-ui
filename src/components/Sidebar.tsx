import { Link, useLocation } from "@tanstack/react-router"
import {
  Server,
  LayoutDashboard,
  Boxes,
} from "lucide-react"

const nav = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/nodes", label: "Nodes", icon: Boxes },
]

export function Sidebar() {
  const location = useLocation()
  return (
    <aside className="w-60 shrink-0 border-r border-border bg-card/40 p-4 hidden md:block">
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
      <nav className="mt-4 flex flex-col gap-1">
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
    </aside>
  )
}
