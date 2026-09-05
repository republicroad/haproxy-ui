export type NodeRow = {
  id: string
  name: string
  apiUrl: string
  apiUser: string
  apiPass: string
  haproxyVersion: string | null
  status: string
  lastSeen: number | null
  createdAt: number
}

export type Frontend = {
  name: string
  mode?: string
  default_backend?: string
  /**
   * v2 dataplaneapi returns an array; v3 models binds as a map keyed by name.
   * Use normalizeFrontend() to always get an array.
   */
  bind?: Array<{ address: string; port: number; name?: string }> | Record<string, { address: string; port: number; name?: string }>
  description?: string
}

export type Server = {
  name: string
  address?: string
  port?: number
  weight?: number
  check?: string
  check_interval?: number
  check_fall?: number
  check_rise?: number
  disabled?: boolean
  backup?: boolean
}

export type Backend = {
  name: string
  mode?: string
  balance?: { algorithm?: string }
  /**
   * v2 dataplaneapi returns an array; v3 models servers as a map keyed by name.
   * Use normalizeBackend() to always get an array.
   */
  servers?: Server[] | Record<string, Server>
  description?: string
}
