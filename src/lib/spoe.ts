/**
 * SPOE/Coraza deep-inspection configuration generator.
 *
 * Community HAProxy has no embedded WAF engine; the supported path for
 * deep packet inspection is the Stream Processing Offload Engine (SPOE)
 * with a Coraza (ModSecurity-compatible) agent. The UI ships ready-made
 * config snippets for a chosen frontend — review, adapt paths/addresses,
 * then apply them on the host. Nothing here is pushed automatically.
 */

export type SpoeInput = {
  frontend: string
  agentAddress: string
  spoeConfigPath: string
}

export function haproxyFilterSnippet(input: SpoeInput): string {
  return [
    `# in global: nothing needed; attach the filter to frontend "${input.frontend}"`,
    `frontend ${input.frontend}`,
    `    filter spoe engine coraza config ${input.spoeConfigPath}`,
    `    # block when the agent flagged the request (severity >= 5, CRS)`,
    `    http-request deny if { var(txn.coraza.fail) -m int gt 0 }`,
  ].join("\n")
}

export function spoeConfigSnippet(input: SpoeInput): string {
  return [
    `# ${input.spoeConfigPath} — SPOE bridge to a Coraza SPOA agent`,
    `[spoe-mapping coraza]`,
    ``,
    `[coraza]`,
    `spoe-agent coraza-agent`,
    `    messages coraza-req`,
    `    option var-prefix  coraza`,
    `    timeout hello      100ms`,
    `    timeout idle       2m`,
    `    timeout processing 500ms`,
    `    use-backend        spoa-coraza`,
    `    option set-on-request txn.coraza.fail`,
    ``,
    `spoe-group coraza-req`,
    `    http-request header X-Coraza-Step-Up`,
    ``,
    `# the agent itself runs out of process; declare its backend in haproxy.cfg:`,
    `# backend spoa-coraza`,
    `#     mode tcp`,
    `#     server coraza ${input.agentAddress} check`,
  ].join("\n")
}

export function corazaAgentSnippet(): string {
  return [
    `# coraza-spoa (docker: ghcr.io/corazawaf/coraza-spoa)`,
    `# config.yaml`,
    `spoa:`,
    `  address: 0.0.0.0`,
    `  port: 9000`,
    `coraza:`,
    `  directives: |`,
    `    Include @crs/setup.conf`,
    `    Include @crs/plugins/_before.conf`,
    `    SecRuleEngine On`,
    `    Include @owasp-crs/crs-setup.conf`,
    `    Include @owasp-crs/plugins/after.conf`,
  ].join("\n")
}
