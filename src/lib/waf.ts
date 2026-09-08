/**
 * HAProxy-native WAF & bot management.
 *
 * Every protection is expressed as *named ACL lines plus one
 * http-request deny rule* referencing them, applied through a validated
 * transaction (the same machinery as the rest of the UI). That means no
 * sidecar daemons: what you see in the UI is plain `acl` / `deny`
 * configuration on the node.
 *
 * Bundle naming convention (used to derive enable/disable state):
 *   waf_<preset-id>        built-in WAF preset
 *   waf_custom_<name>      user-defined WAF rule
 *   bot_block              blocked bot user-agent signatures
 *   bot_detect / bot_allow generic automation detection / verified bots
 */

export type AclLine = { acl_name: string; criterion: string; value?: string }

export type WafPreset = {
  id: string
  label: string
  description: string
  acls: AclLine[]
}

export const aclNameForPreset = (presetId: string): string => `waf_${presetId}`
export const CUSTOM_ACL_PREFIX = "waf_custom_"

/** Built-in WAF presets. Regexes are deliberately conservative (PCRE, -i). */
export const WAF_PRESETS: WafPreset[] = [
  {
    id: "sqli",
    label: "SQL injection",
    description: "Blocks union/select/insert/drop patterns in the path and query string.",
    acls: [
      {
        acl_name: "waf_sqli",
        criterion: "path_reg",
        value: "-i (union([\\x20\\x2b]+)select|select[\\x20\\x2b]+.+[\\x20\\x2b]+from|insert[\\x20\\x2b]+into|drop[\\x20\\x2b]+(table|database)|waitfor[\\x20\\x2b]+delay)",
      },
      {
        acl_name: "waf_sqli",
        criterion: "query_reg",
        value: "-i (union([\\x20\\x2b]+)select|select[\\x20\\x2b]+.+[\\x20\\x2b]+from|or[\\x20\\x2b]+1=1|'--|--')"
      },
    ],
  },
  {
    id: "xss",
    label: "Cross-site scripting",
    description: "Blocks <script>, javascript: URLs and inline event handlers in the query.",
    acls: [
      {
        acl_name: "waf_xss",
        criterion: "query_reg",
        value: "-i (<script|javascript:|onerror[[:space:]]*=|onload[[:space:]]*=|alert[[:space:]]*\\()"
      },
    ],
  },
  {
    id: "traversal",
    label: "Path traversal",
    description: "Blocks ../, ..\\ and URL-encoded traversal attempts.",
    acls: [
      {
        acl_name: "waf_traversal",
        criterion: "path_reg",
        value: "(\\.\\./|%2e%2e[\\/%2f]|\\.\\.\\\\|%5c\\.\\.)",
      },
    ],
  },
  {
    id: "scanner",
    label: "Scanner user-agents",
    description: "Blocks well-known scanner and attack-tool user-agents.",
    acls: [
      {
        acl_name: "waf_scanner",
        criterion: "req.hdr(user-agent)",
        value: "-i -m sub (sqlmap|nikto|nmap[[:space:]]*script|masscan|acunetix|netsparker|nessus|openvas|dirbuster|gobuster|wfuzz|wpscan)",
      },
    ],
  },
  {
    id: "badmethod",
    label: "Dangerous HTTP methods",
    description: "Blocks TRACE and TRACK requests.",
    acls: [
      { acl_name: "waf_badmethod", criterion: "method", value: "TRACE TRACK" },
    ],
  },
]

/** deny-rule condition strings per bundle (kept in one place for tests). */
export const condForPreset = (presetId: string): string => aclNameForPreset(presetId)
export const BOT_BLOCK_ACL = "bot_block"
export const BOT_DETECT_ACL = "bot_detect"
export const BOT_ALLOW_ACL = "bot_allow"
export const IP_DENY_ACL = "ip_deny"
export const IP_ALLOW_ACL = "ip_allow"
export const condBotBlock = (): string => BOT_BLOCK_ACL
export const condBotUnknown = (): string => `${BOT_DETECT_ACL} !${BOT_ALLOW_ACL}`
export const condIpDeny = (): string => IP_DENY_ACL
export const condIpAllowOnly = (): string => `!${IP_ALLOW_ACL}`

/** Parse + validate a pasted CIDR/host list (one entry per line or space). */
export function parseCidrList(raw: string): { valid: string[]; invalid: string[] } {
  const tokens = raw
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/
  const valid: string[] = []
  const invalid: string[] = []
  for (const t of tokens) {
    if (ipv4.test(t) || /^[a-zA-Z0-9.-]+$/.test(t)) valid.push(t)
    else invalid.push(t)
  }
  return { valid, invalid }
}

/** One ACL line holding the whole list (HAProxy ACL values are OR'ed). */
export function cidrAclLine(aclName: string, cidrs: string[]): AclLine {
  return { acl_name: aclName, criterion: "src", value: cidrs.join(" ") }
}

/** Sensible starting signature sets (editable in the UI). */
export const DEFAULT_BLOCKED_BOTS = [
  "sqlmap",
  "nikto",
  "masscan",
  "zgrab",
  "gobuster",
  "python-requests",
]

export const DEFAULT_VERIFIED_BOTS = [
  "Googlebot",
  "bingbot",
  "DuckDuckBot",
  "Baiduspider",
  "YandexBot",
]

/** Generic automation detection used by the "block unknown bots" toggle. */
export const BOT_DETECT_LINE: AclLine = {
  acl_name: BOT_DETECT_ACL,
  criterion: "req.hdr(user-agent)",
  value: "-i -m sub (bot|crawl|spider|scan|headless)",
}

export type HttpRuleLike = {
  type: string
  http_rule_condition?: { cond: string; val?: string }
}

/**
 * Condition tokens referenced by a deny rule: `bot_detect !bot_allow`
 * yields ["bot_detect", "!bot_allow"], `waf_sqli` yields ["waf_sqli"].
 */
export function condTokens(cond: string | undefined): string[] {
  return (cond ?? "").trim().split(/\s+/).filter(Boolean)
}

/** True when the deny rule's condition references `aclName` (incl. `!name`). */
export function denyReferences(rule: HttpRuleLike, aclName: string): boolean {
  if (rule.type !== "deny") return false
  return condTokens(rule.http_rule_condition?.val).some(
    (t) => t.replace(/^!/, "") === aclName,
  )
}

/** First deny rule referencing `aclName`, or -1. */
export function findDenyIndex(rules: HttpRuleLike[], aclName: string): number {
  return rules.findIndex((r) => denyReferences(r, aclName))
}

/** All indexes of ACL lines with the given name (delete in reverse order). */
export function aclIndicesByName(acls: AclLine[], name: string): number[] {
  const out: number[] = []
  acls.forEach((a, i) => {
    if (a.acl_name === name) out.push(i)
  })
  return out
}

export function aclValueForSignature(signature: string): string {
  return `-i -m sub ${signature}`
}

/** Extract the raw signature back out of an `-i -m sub X` ACL value. */
export function signatureFromAclValue(value: string | undefined): string {
  return (value ?? "").replace(/^-i\s+-m\s+sub\s+/, "")
}

// --- fleet sync helpers ---

const BOT_ACL_NAMES = new Set([
  BOT_BLOCK_ACL,
  BOT_DETECT_ACL,
  BOT_ALLOW_ACL,
  IP_DENY_ACL,
  IP_ALLOW_ACL,
])

/** WAF presets, custom rules and bot lists all live under these names. */
export function isProtectionAclName(name: string): boolean {
  return name.startsWith("waf_") || BOT_ACL_NAMES.has(name)
}

/** True when a deny rule's condition references any protection ACL. */
export function ruleReferencesProtection(rule: HttpRuleLike): boolean {
  if (rule.type !== "deny") return false
  return condTokens(rule.http_rule_condition?.val).some(
    (t) => isProtectionAclName(t.replace(/^!/, "")),
  )
}
