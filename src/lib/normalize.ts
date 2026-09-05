import type { Frontend, Backend, Server } from "#/lib/types"

/**
 * dataplaneapi v3 returns `Backend.servers` / `Frontend.binds` as maps keyed
 * by name ({"s1": {...}}) in some versions, while v2-style payloads (and our
 * mock) use arrays. Normalize both shapes into arrays everywhere we read
 * config, so the rest of the app can rely on arrays.
 */

type MaybeMap<T> = T[] | Record<string, T> | undefined | null

function toArray<T extends { name?: string }>(value: MaybeMap<T>): T[] {
  if (!value) return []
  if (Array.isArray(value)) return value
  return Object.entries(value).map(([key, item]) => ({
    // map keys are authoritative; fill name if absent
    name: item?.name ?? key,
    ...item,
  }))
}

export function normalizeFrontend(f: Frontend): Frontend {
  return { ...f, bind: toArray(f.bind) }
}

export function normalizeBackend(b: Backend): Backend {
  return { ...b, servers: toArray(b.servers) as Server[] }
}

export function normalizeFrontends(list: Frontend[] | null | undefined): Frontend[] {
  return (list ?? []).map(normalizeFrontend)
}

export function normalizeBackends(list: Backend[] | null | undefined): Backend[] {
  return (list ?? []).map(normalizeBackend)
}

/** Typed accessor for a (possibly map-shaped) servers field as an array. */
export function serversOf(b: Backend | undefined | null): Server[] {
  const s = b?.servers
  return Array.isArray(s) ? s : []
}
