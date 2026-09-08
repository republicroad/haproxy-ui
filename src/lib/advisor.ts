import type { Frontend, Backend } from "#/lib/types"

/**
 * Configuration best-practice advisor: static analysis over the fetched
 * section data (pure, unit-testable). Findings are advisory only — every
 * real change still goes through validated transactions.
 */

export type FindingSeverity = "high" | "medium" | "low"

export type Finding = {
  severity: FindingSeverity
  title: string
  detail: string
  where: string
}

export type AdvisorInput = {
  frontends: Frontend[]
  backends: Backend[]
  /** frontend name -> target backend names of its backend_switching_rules */
  switchingTargets?: Record<string, string[]>
  /** backend name -> http_request_rules (for stick-table consistency) */
  backendRequestRules?: Record<string, { type: string }[]>
  /** frontend name -> number of log targets */
  logTargetCounts?: Record<string, number>
}

function serverList(b: Backend): { name?: string; address?: string; port?: number; check?: string }[] {
  return (b.servers ?? []) as { name?: string; address?: string; port?: number; check?: string }[]
}

function hasStickTable(b: Backend): boolean {
  return Boolean((b as unknown as { stick_table?: unknown }).stick_table)
}

export function analyzeConfig(input: AdvisorInput): Finding[] {
  const findings: Finding[] = []
  const beNames = new Set(input.backends.map((b) => b.name))

  for (const fe of input.frontends) {
    const switching = (input.switchingTargets?.[fe.name] ?? []).length
    if (!fe.default_backend && switching === 0) {
      findings.push({
        severity: "medium",
        title: "Frontend has no default backend and no switching rules",
        detail:
          "All traffic arriving on this frontend is answered with a default " +
          "503. Set a default backend or add a use_backend rule.",
        where: `frontend/${fe.name}`,
      })
    } else if (fe.default_backend && !beNames.has(fe.default_backend)) {
      findings.push({
        severity: "high",
        title: "Default backend does not exist",
        detail: `default_backend "${fe.default_backend}" matches no configured backend; reloads with this config will fail.`,
        where: `frontend/${fe.name}`,
      })
    }
    if ((input.logTargetCounts?.[fe.name] ?? 0) === 0) {
      findings.push({
        severity: "low",
        title: "No log targets",
        detail:
          "Without a log target this frontend emits nothing to syslog — " +
          "the access-log explorer stays empty for it.",
        where: `frontend/${fe.name}`,
      })
    }
  }

  for (const b of input.backends) {
    const servers = serverList(b)
    if (servers.length === 0) {
      findings.push({
        severity: "medium",
        title: "Backend has no servers",
        detail: "Requests switched to this backend are answered with 503.",
        where: `backend/${b.name}`,
      })
    }
    for (const s of servers) {
      if (s.check !== "enabled") {
        findings.push({
          severity: "low",
          title: "Server has no active health check",
          detail:
            "Failures are only detected when traffic already fails. Enable " +
            "checks (and add an http-check expectation for HTTP backends).",
          where: `backend/${b.name}/server/${s.name ?? "?"}`,
        })
      }
    }

    // duplicate addresses in one backend defeat load balancing
    const seen = new Set<string>()
    for (const s of servers) {
      const key = `${s.address}:${s.port ?? "?"}`
      if (s.address && seen.has(key)) {
        findings.push({
          severity: "medium",
          title: "Duplicate server address",
          detail: `Two servers share ${key}; one of them never receives traffic.`,
          where: `backend/${b.name}`,
        })
        break
      }
      if (s.address) seen.add(key)
    }

    const rules = input.backendRequestRules?.[b.name] ?? []
    const tracks = rules.filter((r) => r.type.startsWith("track-sc")).length
    if (tracks > 0 && !hasStickTable(b)) {
      findings.push({
        severity: "high",
        title: "track-sc rule without a stick-table",
        detail:
          "track-sc references a stick-table that this backend does not " +
          "declare — haproxy -c will reject the config on the next reload.",
        where: `backend/${b.name}`,
      })
    }
    if (tracks === 0 && hasStickTable(b)) {
      findings.push({
        severity: "low",
        title: "Stick-table without a track rule",
        detail: "The declared stick-table is never populated — dead weight.",
        where: `backend/${b.name}`,
      })
    }
  }

  // orphaned backends (not referenced by any frontend default or switching rule)
  const referenced = new Set<string>()
  for (const fe of input.frontends) {
    if (fe.default_backend) referenced.add(fe.default_backend)
  }
  for (const targets of Object.values(input.switchingTargets ?? {})) {
    for (const t of targets) referenced.add(t)
  }
  for (const b of input.backends) {
    if (!referenced.has(b.name) && !b.name.startsWith("_")) {
      findings.push({
        severity: "low",
        title: "Backend is not referenced by any frontend",
        detail:
          "Nothing routes to this backend (no default_backend or use_backend rule points at it).",
        where: `backend/${b.name}`,
      })
    }
  }

  return findings
}
