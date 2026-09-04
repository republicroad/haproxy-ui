"use client"

import type React from "react"
import { Input } from "./ui/input"

/**
 * Search box wired to a TanStack table's global filter via controlled state.
 * The owning component keeps `globalFilter` state and passes it through:
 *
 *   const [q, setQ] = useState("")
 *   const table = useTable({ data, columns, features, state: { globalFilter: q }, onGlobalFilterChange: setQ })
 *   <GridSearchInput value={q} onChange={setQ} />
 */
export function GridSearchInput({
  value,
  onChange,
  placeholder = "Search…",
  className,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
}) {
  return (
    <Input
      value={value}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`max-w-64 ${className ?? ""}`}
      aria-label={placeholder}
    />
  )
}
