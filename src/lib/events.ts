import { EventEmitter } from "node:events"

export type AppEvent =
  | { type: "change"; nodeId: string }
  | { type: "node_status"; nodeId: string; status: "up" | "down" }
  | { type: "users_changed" }

/**
 * In-process pub/sub for server-sent events. The SSE endpoint subscribes
 * here; change-write paths and the health prober publish. A single global
 * emitter (like the db singleton) survives dev HMR.
 */
const globalForBus = globalThis as unknown as { __haproxyUiBus?: EventEmitter }

export const bus: EventEmitter =
  globalForBus.__haproxyUiBus ?? (globalForBus.__haproxyUiBus = new EventEmitter())

bus.setMaxListeners(100)

export function publish(event: AppEvent): void {
  bus.emit("event", event)
}
