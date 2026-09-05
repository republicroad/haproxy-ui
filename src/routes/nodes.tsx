import { createFileRoute, Outlet } from "@tanstack/react-router"

/**
 * Layout route for /nodes. Children:
 *  - nodes.index.tsx  → /nodes (list)
 *  - nodes.$id.tsx    → /nodes/$id (detail)
 */
export const Route = createFileRoute("/nodes")({
  component: Outlet,
})
