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
  bind?: Array<{ address: string; port: number; name?: string }>
  description?: string
}

export type Server = {
  name: string
  address?: string
  port?: number
  weight?: number
  check?: string
  disabled?: boolean
  backup?: boolean
}

export type Backend = {
  name: string
  mode?: string
  balance?: { algorithm?: string }
  servers?: Server[]
  description?: string
}
