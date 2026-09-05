"use client"

import { useEffect } from "react"
import { useQueryClient, type Query } from "@tanstack/react-query"
import { toast } from "sonner"

type AppEvent =
  | { type: "hello"; ts: number }
  | { type: "change"; nodeId: string }
  | { type: "node_status"; nodeId: string; status: "up" | "down" }
  | { type: "users_changed" }

/**
 * Subscribe to the server's SSE stream and keep query caches fresh.
 * Polling stays in place as a fallback; events only accelerate updates.
 */
export function useAppEvents() {
  const qc = useQueryClient()

  useEffect(() => {
    let es: EventSource | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let closed = false

    const connect = () => {
      es = new EventSource("/api/events")
      es.onmessage = (m) => {
        let e: AppEvent
        try {
          e = JSON.parse(m.data)
        } catch {
          return
        }
        if (e.type === "change") {
          // refresh history + config queries scoped to the node
          qc.invalidateQueries({
            predicate: (q: Query) =>
              q.queryKey[0] === "changes" &&
              (q.queryKey[1] === e.nodeId || q.queryKey[1] === undefined),
          })
          qc.invalidateQueries({ queryKey: ["frontends", e.nodeId] })
          qc.invalidateQueries({ queryKey: ["backends", e.nodeId] })
          qc.invalidateQueries({ queryKey: ["acls", e.nodeId] })
          qc.invalidateQueries({ queryKey: ["raw", e.nodeId] })
        } else if (e.type === "node_status") {
          qc.invalidateQueries({ queryKey: ["nodes"] })
          qc.invalidateQueries({ queryKey: ["node", e.nodeId] })
          qc.invalidateQueries({ queryKey: ["health-summary"] })
          qc.invalidateQueries({ queryKey: ["runtime-servers", e.nodeId] })
          toast.message(`Node is ${e.status}`, {
            description: "Fleet status updated",
          })
        } else if (e.type === "users_changed") {
          qc.invalidateQueries({ queryKey: ["users"] })
        }
      }
      es.onerror = () => {
        // EventSource retries on its own, but a hard failure can leave it
        // in CLOSED state - reopen after a backoff.
        es?.close()
        if (!closed) {
          retry = setTimeout(connect, 5_000)
        }
      }
    }

    connect()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      es?.close()
    }
  }, [qc])
}
