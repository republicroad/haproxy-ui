# Coraza WAF Integration with HAProxy

## Overview

This document describes the industry best practice for implementing a Web Application Firewall (WAF) on **open-source HAProxy** using **Coraza WAF** via the **SPOE (Stream Processing Offload Engine)** protocol.

**Status**: Design documentation for future implementation. Not yet implemented in haproxy-ui.

**Reference Implementation**: `github.com/corazawaf/coraza-spoa` (actively maintained, v0.7.3 released Sept 2026)

---

## Architecture

```
┌─────────────┐     HTTP Request      ┌─────────────┐     SPOP Protocol      ┌──────────────────┐
│   Client    │ ─────────────────────▶ │   HAProxy   │ ─────────────────────▶ │   coraza-spoa    │
└─────────────┘                         │ (filter spoe)│                      │  (Coraza Engine  │
                                        │              │  ◀──────────────────  │  + OWASP CRS v4) │
         ▲                              └──────┬───────┘     WAF Decision     └──────────────────┘
         │                                     │
         │                    Block / Allow / Drop (via txn.coraza.action)
         │                                     │
         ▼                              ┌──────┴───────┐
┌─────────────┐                         │   Backend    │
│  Response   │ ◀────────────────────── │  (Upstream)  │
└─────────────┘                         └──────────────┘
```

**Key Principle**: HAProxy executes enforcement; Coraza only decides. The decision flows through HAProxy transaction variables (`txn.coraza.*`).

---

## Configuration

### 1. HAProxy Frontend Configuration (`haproxy.cfg`)

```haproxy
frontend web
    bind *:80
    bind *:443 ssl crt /etc/haproxy/certs/

    # Application identifier (must match coraza-spoa.yaml application name)
    http-request set-var(txn.coraza.app) str(my_web_app)

    # IMPORTANT: Rules that must run BEFORE WAF inspection go HERE
    # (e.g., allow-list health checks, static asset bypass)

    # Enable SPOE filter for Coraza
    filter spoe engine coraza config /etc/haproxy/coraza.cfg

    # Trigger request inspection
    http-request send-spoe-group coraza coraza-req

    # Enforcement actions based on Coraza decision
    http-request deny deny_status 403 \
        hdr waf-block "request" \
        if { var(txn.coraza.action) -m str deny }

    http-request silent-drop \
        if { var(txn.coraza.action) -m str drop }

    # Optional: fail-closed on SPOE errors (default is fail-open)
    http-request deny deny_status 500 \
        if { var(txn.coraza.error) -m int gt 0 }

    # Optional: response inspection (requires coraza-res message in SPOE config)
    # http-response deny deny_status 403 \
    #     hdr waf-block "response" \
    #     if { var(txn.coraza.action) -m str deny }

    default_backend my_app

backend my_app
    server app1 10.0.0.10:80 check
```

### 2. SPOE Configuration (`/etc/haproxy/coraza.cfg`)

```haproxy
# coraza.cfg - SPOE filter configuration for coraza-spoa
# Source: coraza-spoa example/haproxy/coraza.cfg

[coraza]
spoe-agent coraza-agent
    messages   coraza-res        # Response inspection (optional)
    groups     coraza-req
    option     var-prefix   coraza
    option     set-on-error error
    # NOTE: timeout hello/idle are DEPRECATED in HAProxy SPOE v1.2 (2024-07-12)
    timeout    processing   500ms   # Critical: caps added latency
    use-backend coraza-spoa
    log        global

spoe-message coraza-req
    args app=var(txn.coraza.app) src-ip=src src-port=src_port \
         dst-ip=dst dst-port=dst_port method=method path=path \
         query=query version=req.ver headers=req.hdrs body=req.body \
         exportRuleIDs=bool(false)

spoe-message coraza-res
    args app=var(txn.coraza.app) id=var(txn.coraza.id) \
         version=res.ver status=status headers=res.hdrs body=res.body \
         exportRuleIDs=bool(false) detect-only=bool(false)
    event on-http-response

spoe-group coraza-req
    messages coraza-req

# Backend pointing to coraza-spoa agent
backend coraza-spoa
    mode tcp
    option spop-check
    server coraza_spoa 127.0.0.1:9000 check
```

### 3. Coraza-SPOA Agent Configuration (`/etc/coraza-spoa/coraza-spoa.yaml`)

```yaml
# coraza-spoa.yaml
# Source: coraza-spoa example/coraza-spoa.yaml

bind: "0.0.0.0:9000"              # Default port 9000 (not 9002)
# unix: "/run/coraza-spoa/coraza-spoa.sock"  # Alternative: Unix socket

# Transaction TTL (ms) - caches WAF transaction across request/response
transaction_ttl_ms: 60000

# Default application if txn.coraza.app doesn't match
default_application: "default"

applications:
  - name: "my_web_app"
    # Coraza directives with embedded CRS v4
    directives: |
      # Recommended Coraza base config
      Include @coraza.conf-recommended

      # CRS setup - tune paranoia level here (1-4)
      Include @crs-setup.conf.example
      SecAction "id:900130,phase:1,nolog,pass,t:none,setvar:tx.paranoia_level=2"

      # Load all OWASP CRS v4 rules
      Include @owasp_crs/*.conf

      # Engine mode: On | DetectionOnly
      SecRuleEngine On

      # Custom exclusions go AFTER CRS includes (configure-time)
      # SecRuleRemoveById 942100  # Example: exclude SQLi rule for specific app

    # Disable response inspection for this app (faster)
    # response_check: false

  - name: "api_service"
    directives: |
      Include @coraza.conf-recommended
      Include @crs-setup.conf.example
      SecAction "id:900130,phase:1,nolog,pass,t:none,setvar:tx.paranoia_level=1"
      Include @owasp_crs/*.conf
      SecRuleEngine On
    # response_check: true

# Logging
log_level: "info"
```

---

## Deployment Options

### Option A: Binary (Same Host as HAProxy)

```bash
# Build from source
git clone https://github.com/corazawaf/coraza-spoa
cd coraza-spoa
go run mage.go build
# Binary at ./build/coraza-spoa

# Run with config
./build/coraza-spoa -config /etc/coraza-spoa/coraza-spoa.yaml

# Validate config only
./build/coraza-spoa -validate -config /etc/coraza-spoa/coraza-spoa.yaml
```

**Systemd Unit** (hardened, from `contrib/`):
```ini
[Unit]
Description=Coraza SPOA WAF Agent
After=network.target

[Service]
Type=simple
User=haproxy
Group=haproxy
ExecStart=/usr/local/bin/coraza-spoa -config /etc/coraza-spoa/coraza-spoa.yaml
Restart=on-failure
RestartSec=5
# Hardening
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/run/coraza-spoa
NoNewPrivileges=true
PrivateNetwork=false  # Needed to accept HAProxy connections

[Install]
WantedBy=multi-user.target
```

### Option B: Docker / Docker Compose

```yaml
# docker-compose.yml
services:
  haproxy:
    image: haproxy:3.1
    volumes:
      - ./haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro
      - ./coraza.cfg:/usr/local/etc/haproxy/coraza.cfg:ro
    ports:
      - "80:80"
      - "443:443"
    depends_on:
      - coraza-spoa

  coraza-spoa:
    image: ghcr.io/corazawaf/coraza-spoa:latest  # distroless, Renovate-maintained
    volumes:
      - ./coraza-spoa.yaml:/etc/coraza-spoa/coraza-spoa.yaml:ro
    # ports: ["9000:9000"]  # Not needed if on same Docker network
```

### Option C: Kubernetes (Helm)

```bash
helm repo add coraza https://corazawaf.github.io/charts
helm install coraza-spoa coraza/coraza-spoa \
  --set config.applications[0].name=my_web_app \
  --set config.applications[0].directives="Include @coraza.conf-recommended\nInclude @crs-setup.conf.example\nInclude @owasp_crs/*.conf\nSecRuleEngine On"
```

---

## CRS Integration Details

### CRS Version Compatibility

| Coraza-SPOA Release | Embedded CRS (via coraza-coreruleset) | Upstream CRS |
|---------------------|----------------------------------------|--------------|
| v0.7.x (2026)       | v4.22 → v4.25                          | v4.29 (Aug 2026) |

- **100% CRS v4 compatibility** claimed by Coraza
- CRS loaded via Go embed (`@owasp_crs/*.conf`) — no filesystem needed
- Renovate bot keeps `coraza-coreruleset` dependency current

### Paranoia Levels (PL)

| Level | Use Case | False Positive Risk |
|-------|----------|---------------------|
| PL1   | Baseline, public sites | Near zero |
| PL2   | E-commerce, SaaS | Expected — requires tuning |
| PL3   | Banking, healthcare | High — weeks of tuning |
| PL4   | Crown jewels | Very high |

**Best Practice**: Use `tx.paranoia_level` variable in CRS setup. Run **execution PL > blocking PL** so new rules log but don't add to anomaly score during soak period.

```haproxy
# In coraza-spoa.yaml directives:
SecAction "id:900130,phase:1,nolog,pass,t:none,setvar:tx.paranoia_level=2"
SecAction "id:900131,phase:1,nolog,pass,t:none,setvar:tx.blocking_paranoia_level=1"
```

---

## Operational Best Practices

### 1. Learning Mode Before Enforcement

**Phase 1: Detection Only**
```yaml
# coraza-spoa.yaml
directives: |
  Include @coraza.conf-recommended
  Include @crs-setup.conf.example
  Include @owasp_crs/*.conf
  SecRuleEngine DetectionOnly   # Log only, never block
```

**Phase 2: Response Detect-Only (coraza-spoa v0.7.0+)**
```yaml
# In SPOE config, response message:
detect-only=bool(true)
```
Returns immediately to HAProxy; evaluates response rules in background for logging only.

**Phase 3: Gradual Enforcement**
- Monitor `txn.coraza.anomaly_score`, `txn.coraza.rules_hit`, `txn.coraza.rule_ids` in logs
- Tune false positives (see below)
- Flip `SecRuleEngine On` per application

### 2. False Positive Handling

**Never fork CRS rule files.** Use exclusions:

**Configure-time (after CRS includes):**
```apache
# Remove specific rule entirely
SecRuleRemoveById 942100

# Remove rule from specific variable
SecRuleUpdateTargetById 942100 !ARGS:user_input
```

**Runtime (before CRS includes — more flexible):**
```apache
# Remove target for specific path
SecRule REQUEST_URI "@beginsWith /api/webhook" \
  "id:100001,phase:1,pass,nolog,ctl:ruleRemoveTargetById=942100;ARGS:payload"

# WordPress/Nextcloud/Drupal exclusion packages (official CRS)
SecAction "id:100010,phase:1,nolog,pass,t:none,setvar:tx.crs_exclusions_wordpress=1"
```

**Rule ID Conventions** (for custom rules):
- `100000–189999` — Infrastructure/whitelists (ignored by anomaly counters)
- `190000–199999` — Custom blocking rules (counted, exported in `rule_ids`)

### 3. Latency Management

| Technique | Description |
|-----------|-------------|
| Co-locate agent | Run coraza-spoa on same host as HAProxy (sub-ms latency) |
| `timeout processing` | Cap worst-case: `500ms` in SPOE config |
| `option set-process-time` | Export SPOE latency to variable for monitoring |
| `option set-total-time` | Export total SPOE time |
| Pipelining | Always enabled in SPOE v1.2+ |

```haproxy
# In coraza.cfg spoe-agent section:
option set-process-time waf_spoe_processing
option set-total-time waf_spoe_total
```

### 4. Logging

**WAF Event Variables** (available in `log-format`):
```haproxy
# Standard tracking
log-format "%ci:%cp [%tr] %ft %b/%s %TR/%Tw/%Tc/%Tr/%Ta %ST %B %CC %CS %tsc %ac/%fc/%bc/%sc/%rc %sq/%bq %{+Q}r waf_action=%[var(txn.coraza.action)] waf_score=%[var(txn.coraza.anomaly_score)] waf_rules=%[var(txn.coraza.rules_hit)]"

# Debug mode (per-rule IDs) — add exportRuleIDs=bool(true) to SPOE message
# waf_rule_ids=%[var(txn.coraza.rule_ids)]
```

**SPOE Internal Logs** (via `log global` in spoe-agent):
```
SPOE: [AGENT] coraza-req SENT    pT 1.2ms  # processing time
SPOE: [AGENT] coraza-req RECV    pT 0.8ms
```

Silence successful events:
```haproxy
spoe-agent coraza-agent
    option dontlog-normal
```

### 5. Fail-Open vs Fail-Closed

| Strategy | Configuration | When to Use |
|----------|---------------|-------------|
| **Fail-Open** (default) | No `txn.coraza.error` rule; on timeout/error request passes | High availability priority; non-critical paths |
| **Fail-Closed** | `http-request deny deny_status 500 if { var(txn.coraza.error) -m int gt 0 }` | Regulated environments; critical APIs |

**Hybrid**: Fail-open for most traffic, fail-closed for sensitive endpoints:
```haproxy
acl sensitive path_beg /api/admin /api/payment
http-request deny deny_status 500 if sensitive { var(txn.coraza.error) -m int gt 0 }
```

### 6. CRS Upgrade Procedure

1. **Pin version** in deployment (Docker tag, Helm chart version, binary release)
2. Read coraza-spoa CHANGELOG for embedded CRS version bump
3. Deploy to staging with `SecRuleEngine DetectionOnly`
4. Run **go-ftw** regression tests (coraza-spoa CI uses these)
5. Run your false-positive regression suite
6. Flip to `SecRuleEngine On` after validation

---

## Alternative Approaches Comparison

| Approach | Maturity | Maintenance | Coverage | Best For |
|----------|----------|-------------|----------|----------|
| **Coraza SPOA + CRS** | ✅ Production | Active (Coraza core team) | Full CRS v4 | Open-source HAProxy WAF standard |
| ModSecurity v3 in HAProxy | ❌ Not supported | N/A | N/A | N/A — no OSS integration |
| HAProxy Enterprise WAF | ✅ Enterprise | Vendor-supported | Proprietary + CRS | Budget allows, need SLA |
| External WAF (Cloudflare, AWS WAF, etc.) | ✅ Managed | Vendor | Varies | Offload ops, bot mgmt, TLS term upstream |
| Native ACL "Poor Man's WAF" | ✅ Native | Self | Partial (no body inspect) | Complement only; scanner noise reduction |
| stick-table Rate Limiting | ✅ Native | Self | L7 DDoS, brute-force | **Essential complement** to any WAF |
| fail2ban / CrowdSec | Community | Varies | Log-based reactive | Legacy setups; CrowdSec preferred |

**Native ACL Patterns** (from HAProxy blog):
```haproxy
# Block known bad User-Agents
acl bad_ua hdr(user-agent) -m sub -i sqlmap nikto nessus
http-request deny deny_status 403 if bad_ua

# Harden sensitive paths
acl admin_path path_beg /admin /wp-admin /phpmyadmin
http-request deny deny_status 403 if admin_path !{ src -f /etc/haproxy/allowlist.lst }

# Method allow-list
http-request deny deny_status 405 unless { method GET HEAD POST OPTIONS }

# Malformed HTTP (as in Coraza example)
http-request deny deny_status 400 if !HTTP_1.0 !HTTP_1.1 !HTTP_2.0

# Rate limiting (stick-table)
stick-table type ip size 100k expire 2m store http_req_rate(1m)
http-request track-sc0 src
http-request deny deny_status 429 if { sc_http_req_rate(0) gt 100 }
```

---

## Integration with haproxy-ui (Future Implementation)

When implemented, haproxy-ui can manage the **configuration orchestration** layer:

### Planned Capabilities

| Feature | Description |
|---------|-------------|
| **SPOE Config Generation** | Generate `coraza.cfg` from UI (applications, timeouts, backend refs) |
| **Per-Application CRS Tuning** | PL selector, `SecRuleEngine` mode (DetectionOnly/On), per-app exclusions UI |
| **Exclusion Rule Management** | Visual editor for `SecRuleRemoveById`, `ctl:ruleRemoveTargetById` with path scoping; stored in SQLite, versioned in history |
| **Mode Toggle** | One-click DetectionOnly ⇄ On per application (with confirmation) |
| **Event Correlation** | Parse `txn.coraza.*` from logs → dashboard (anomaly score trends, top rules hit, blocked IPs) |
| **Alert Integration** | WAF blocks → existing webhook/SSE alert pipeline |
| **CRS Version Tracking** | Display embedded CRS version; upgrade workflow with detect-only validation gate |

### Non-Goals (Out of Scope)

- **coraza-spoa process lifecycle** (deployment via Docker/systemd/Helm is infrastructure concern)
- **HAProxy reload on WAF config change** (already handled by existing transactional config pipeline)
- **Rule authoring** (use CRS; custom rules via exclusion UI only)

### Data Model Additions (Future)

```sql
-- WAF application configuration
CREATE TABLE waf_applications (
    id TEXT PRIMARY KEY,
    node_group_id TEXT REFERENCES node_groups(id),
    name TEXT NOT NULL,                    -- matches txn.coraza.app
    paranoia_level INTEGER DEFAULT 2,      -- 1-4
    blocking_paranoia_level INTEGER DEFAULT 1,
    engine_mode TEXT DEFAULT 'DetectionOnly', -- 'DetectionOnly' | 'On'
    response_inspection BOOLEAN DEFAULT false,
    directives_override TEXT,              -- custom SecRule* lines (append)
    created_at INTEGER, updated_at INTEGER
);

-- Exclusion rules (per application)
CREATE TABLE waf_exclusions (
    id TEXT PRIMARY KEY,
    waf_application_id TEXT REFERENCES waf_applications(id) ON DELETE CASCADE,
    rule_id INTEGER NOT NULL,              -- CRS rule ID to exclude
    type TEXT NOT NULL,                    -- 'remove' | 'remove_target' | 'update_target'
    target TEXT,                           -- e.g., 'ARGS:payload' for remove_target
    condition TEXT,                        -- optional SecRule condition (e.g., REQUEST_URI @beginsWith /api/webhook)
    created_at INTEGER
);

-- WAF audit events (denormalized for dashboard)
CREATE TABLE waf_events (
    id TEXT PRIMARY KEY,
    timestamp INTEGER NOT NULL,
    node_id TEXT NOT NULL,
    application TEXT NOT NULL,
    client_ip TEXT,
    method TEXT, path TEXT,
    action TEXT,                           -- 'deny' | 'drop' | 'pass' | 'error'
    anomaly_score INTEGER,
    rule_ids TEXT,                         -- JSON array
    error_code INTEGER
);
```

---

## Quick Reference: Common Tasks

### Add New Application WAF Profile

1. Add application block to `coraza-spoa.yaml`
2. Set `http-request set-var(txn.coraza.app) str(<name>)` in target frontend
3. Reload HAProxy (transactional config)
4. Reload coraza-spoa (`systemctl reload coraza-spoa` or SIGHUP)

### Tune False Positive for `/api/webhook` Payload

```yaml
# In coraza-spoa.yaml, application.directives:
SecRule REQUEST_URI "@beginsWith /api/webhook" \
  "id:100001,phase:1,pass,nolog,ctl:ruleRemoveTargetById=942100;ARGS:payload"
```

Reload coraza-spoa only (no HAProxy reload needed).

### Enable Response Inspection for Data Leak Prevention

```haproxy
# In coraza.cfg:
spoe-agent coraza-agent
    messages coraza-req coraza-res   # Add coraza-res

# In haproxy.cfg frontend:
http-response deny deny_status 403 \
    hdr waf-block "response" \
    if { var(txn.coraza.action) -m str deny }
```

### Monitor WAF Latency

```haproxy
# In coraza.cfg spoe-agent:
option set-process-time waf_proc
option set-total-time waf_total

# In log-format:
%[var(txn.waf_proc)] %[var(txn.waf_total)]
```

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| 500 errors on all requests | coraza-spoa down / unreachable | Check backend health (`spop-check`), firewall, process status |
| High latency spikes | `timeout processing` too high or agent overloaded | Lower timeout; scale agent; check `waf_proc` metric |
| Legitimate traffic blocked | CRS false positive | Review `waf_rule_ids`, add exclusion; consider lower PL |
| WAF not triggering | `send-spoe-group` missing or before `filter spoe` | Move `filter spoe` before `send-spoe-group`; verify var name |
| Response inspection not working | `coraza-res` message not in SPOE config | Add `messages coraza-res` to spoe-agent; define `spoe-message coraza-res` |

---

## References

- **coraza-spoa Repository**: https://github.com/corazawaf/coraza-spoa
- **Coraza WAF Engine**: https://github.com/corazawaf/coraza
- **OWASP CoreRuleSet**: https://coreruleset.org/
- **HAProxy SPOE Documentation**: https://github.com/haproxy/haproxy/blob/master/doc/SPOE.txt
- **HAProxy Blog - Coraza WAF**: (original post deprecated; coraza-spoa README is canonical)
- **HAProxy Blog - Response Policies**: https://www.haproxy.com/blog/use-haproxy-response-policies-to-stop-threats
- **HAProxy Blog - Rate Limiting**: https://www.haproxy.com/blog/four-examples-of-haproxy-rate-limiting
- **CRS Paranoia Levels**: https://coreruleset.org/docs/concepts/paranoia_levels/
- **CRS False Positive Handling**: https://coreruleset.org/docs/concepts/false_positives_and_tuning/

---

## Changelog

| Date | Version | Description |
|------|---------|-------------|
| 2026-09-07 | 1.0 | Initial design document based on Coraza SPOA v0.7.3 research |

---

*This document will be updated when implementation begins (planned as P11+).*