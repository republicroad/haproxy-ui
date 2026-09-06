import { createFileRoute } from "@tanstack/react-router"
import { authEnabled, identityFromRequest } from "#/lib/auth"
import { bus, type AppEvent } from "#/lib/events"

/**
 * Server-Sent Events stream. Clients receive app events (config changes,
 * node status flips, user changes) and can refresh caches accordingly.
 * Keep-alive comments every 15s; heartbeats double as liveness probes.
 */
export const Route = createFileRoute("/api/events")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // auth gate (SSE is a GET; RBAC allows all roles to read)
        if (authEnabled() && !identityFromRequest(request)) {
          return Response.json({ error: "unauthorized" }, { status: 401 })
        }

        const encoder = new TextEncoder()
        let heartbeat: ReturnType<typeof setInterval> | undefined
        let onEvent: ((e: AppEvent) => void) | undefined

        const stream = new ReadableStream({
          start(controller) {
            const send = (data: string) => {
              try {
                controller.enqueue(encoder.encode(`data: ${data}\n\n`))
              } catch {
                // client disconnected mid-write
              }
            }
            send(JSON.stringify({ type: "hello", ts: Date.now() }))

            onEvent = (e: AppEvent) => send(JSON.stringify(e))
            bus.on("event", onEvent)

            heartbeat = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(": keepalive\n\n"))
              } catch {
                // ignore
              }
            }, 15_000)

            // close cleanup when the client aborts
            request.signal.addEventListener("abort", () => {
              if (heartbeat) clearInterval(heartbeat)
              if (onEvent) bus.off("event", onEvent)
              try {
                controller.close()
              } catch {
                // already closed
              }
            })
          },
          cancel() {
            if (heartbeat) clearInterval(heartbeat)
            if (onEvent) bus.off("event", onEvent)
          },
        })

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
          },
        })
      },
    },
  },
})
