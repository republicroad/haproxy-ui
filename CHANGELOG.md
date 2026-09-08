# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.2.0] - 2026-09-09

RBAC-completion and audit release: OIDC group-claim mapping, CSV audit
export, sync preview and one-click advisor fixes.

### Added
- **OIDC group claims**: HAPROXY_UI_OIDC_GROUP_CLAIM (default groups),
  _ADMIN_GROUPS (IdP groups granting the global admin role) and
  _GROUP_MAP (idpGroup:nodeGroup pairs granting group-admin) let
  role and node-group assignment be managed entirely in the identity
  provider, re-applied on every SSO login.
- **Audit export**: CSV download of a node's configuration change
  history (/api/nodes/:id/changes/export, Export CSV button in the
  history tab).
- **Sync preview**: dry-run computes the full per-target plan (sections,
  servers, WAF bundles) against live target state without writing;
  results show what would be created/skipped before applying.
- **Advisor one-click fix**: enable active health checks on every
  server that has them disabled, in a single validated transaction.

### Fixed
- Group-scoped identities could no longer load the node list page (the
  fleet-wide guard caught the page and its list endpoint); the list is
  group-filtered and both are allowed again.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.1.0] - 2026-09-09

Alerting-closure release: access-log anomaly detection, a notification
history and backup retention.

### Added
- **Access-log anomaly detection**: rolling 5-minute windows per node
  fire webhook/email alerts on 5xx-share spikes, traffic spikes (vs the
  preceding 30-minute baseline) and latency spikes. Thresholds are
  configurable (HAPROXY_UI_ANOMALY_5XX_PCT, _RATE_MULT, _LATENCY_MS,
  _MIN_REQUESTS, _COOLDOWN_MIN, _INTERVAL); every detector requires a
  meaningful sample size.
- **Notification history**: every webhook/email send is recorded with
  channel, kind, subject and delivery status (alert_history, trimmed to
  the newest 200) and shown as a Recent notifications card on the fleet
  health dashboard.

### Changed
- Database backups now prune the oldest snapshots beyond
  HAPROXY_UI_BACKUP_KEEP (default 20).

## [2.0.0] - 2026-09-08

Fleet operations release: fine-grained token scopes, group admins,
session management, database backups, IP access control, the config
advisor and a SPOE/Coraza deep-inspection generator. First release
published with container images and SBOMs.

### Added

#### Identity and access
- **Token scopes** (all | readonly | group:<name>): read-only tokens
  cannot perform any write; group tokens act like admins but only for
  nodes in their group (fleet-wide endpoints denied)
- **Group admins**: admin-role users pinned to a node group may only
  manage nodes of that group; users/tokens/backup endpoints are
  global-admin-only
- **Session management**: sessions are registered with IP/agent and
  last activity, listed on the Users page and individually revocable;
  logout now revokes only the caller's session

#### Operations
- **Database backups**: online VACUUM INTO snapshots of the UI's
  SQLite database via POST /api/db/backup or the Users-page card;
  restore is a documented file swap (litestream guide included)
- **IP access control** (WAF tab): bulk CIDR/hostname allow and deny
  lists per section with one-click enforcement (block listed sources
  / allow only listed sources); lists travel with multi-node sync
- **Config advisor**: static best-practice analysis per node (broken
  backend references, servers without health checks, duplicate server
  addresses, track-sc without stick-table, orphaned backends, missing
  log targets) with severity badges on the overview tab
- **SPOE/Coraza generator**: copy-ready haproxy.cfg, spoe-coraza.conf
  and coraza-spoa config snippets for deep WAF inspection

### Changed
- Release workflow publishes container images to GHCR (versioned +
  latest) with SPDX SBOM and provenance attestation
- Logout no longer invalidates every issued session, only the
  caller's

# Changelog

All notable changes to this project are documented in this file.


## [1.2.0] - 2026-09-07

Safety and insight release: staged-change review before every config
apply, certificate expiry alerting, access-log aggregations and
WAF-aware multi-node sync.

### Added
- **Review before apply** (opt-in, per node header toggle): config
  transactions pause before commit and show the staged raw-config
  diff; cancelling rolls the transaction back. Implemented as a
  preview gate in the transaction helper, so every config editor
  (sections, servers, ACLs, rules, WAF bundles, rate limits) is
  covered without per-page changes.
- **Certificate expiry alerting**: daily scan of each node's stored
  certificates (`HAPROXY_UI_CERT_WARN_DAYS`, default 30) feeding the
  webhook + SMTP alert channels with a per-certificate 24h cooldown;
  X.509 parsing extracted into a shared server module.
- **Access-log aggregations** (`/api/logs/stats`): status-class totals
  and average latency, per-5-minute request trend with 5xx overlay,
  top clients and per-frontend breakdown — all computed SQL-side and
  rendered above the request table.
- **WAF sync**: "Include WAF & bot rules" in the sync dialog carries
  each selected section's protection ACL bundles and deny rules to
  target nodes, idempotent by (name, criterion, value) triple and
  condition string.
- API docs link to `/api/openapi` from the tokens page.

### Changed
- Alert delivery (webhook + email) extracted into a shared module now
  reused by the health pipeline and the certificate checker.
- The Prometheus endpoint counts recent log records with a SQL
  `COUNT(*)` instead of materializing up to 1000 rows per node.
- Dockerfile declares `1514/udp` for the access-log receiver (was TCP
  only, which silently broke log ingestion in container deployments).

## [1.1.0] - 2026-09-07

Rules, protection and operations release: a full traffic-rules engine,
HAProxy-native WAF + bot management, access-log ingestion, Prometheus
endpoint, OIDC/SSO, SMTP alerts and upgrade orchestration.

### Added

#### Rules engine (new "Rules" tab)
- HTTP request rules expanded beyond redirect/deny: set/add/del-header
  with optional conditions
- HTTP response rules (set/add/del-header, deny) per frontend/backend
- TCP request rules (accept/reject) per frontend/backend
- `use_backend` backend switching rules on frontends (target backend +
  if/unless condition)
- Backend active health-check expectations (`http-check expect`
  status/string/rlen) managed per backend
- One-click per-client-IP rate limit preset: writes the backend
  stick-table, a `track-sc0` rule and a `deny 429` rule in a single
  validated transaction

#### WAF & bot management (new "WAF" tab)
- HAProxy-native protection bundles: SQL injection, XSS, path
  traversal, scanner user-agents and dangerous HTTP methods
- Custom WAF rules (criterion + match value) compiled to named ACLs +
  deny rules
- Bot management: editable blocked-signature list, verified-bots
  allowlist, and a "verified bots only" mode that blocks generic
  automation unless allowlisted
- Every toggle is a transaction of named ACL lines plus one deny rule
  (no sidecar daemons), recorded in the change history

#### Observability
- UDP syslog access-log receiver (`HAPROXY_UI_LOG_PORT`) with sampling
  (`HAPROXY_UI_LOG_SAMPLE`), retention (`HAPROXY_UI_LOG_KEEP`) and a
  filterable request explorer tab per node (frontend/status class/path)
- Prometheus exposition endpoint `/api/metrics`: node health, versions,
  latency and the latest sampled per-object stats
- Topology view: live session counts and request rates inline, hover
  details, and click-through navigation to the matching tab
- OpenAPI 3.1 document at `/api/openapi`, schemas generated from
  the API's own zod validators

#### Platform
- OIDC/SSO sign-in (authorization code + PKCE-less state cookie,
  RS256 JWKS verification, discovery caching) with e-mail based user
  provisioning and `HAPROXY_UI_OIDC_ADMIN_EMAILS` admin mapping
- SMTP alert emails alongside webhooks (STARTTLS/implicit TLS,
  AUTH PLAIN/LOGIN, password encrypted at rest, per-channel test send)
- HAProxy binary upgrade orchestration per node: config snapshot,
  optional server drain, version verification and run history
- Rules surface documented for automation (`/api/logs`, `/api/metrics`,
  `/api/nodes/{id}/upgrade`, switching rules, http checks, rate limit)

#### Fixed
- Node detail page loaded empty frontend/backend lists on the ACLs tab
  when visited directly (section pickers are now populated on every
  dependent tab)

### Changed
- Frontend/backend lists now load on every tab that needs them, not
  only their own tabs
- TanStack dependencies pinned to semver ranges (previously `latest`)
  with Dependabot weekly updates

## [1.0.0] - 2026-09-06

First stable release. Full lifecycle management for HAProxy fleets via
the official Data Plane API (v2/v3).

### Added

#### Node management
- Node registry (name, Data Plane API URL, credentials, group) with
  one-click connectivity tests, bulk "test all" and auto-refreshing
  status/version
- Node groups with group-scoped sync target selection
- Import/export of the node registry (credentials stripped)

#### Configuration management
- Frontend/backend/server CRUD inside validated transactions
  (`haproxy -c` + graceful reload), with a mock dataplaneapi for
  development
- Frontend/backend section editing (full_section=false semantics;
  neighbouring objects untouched) and bind editing via
  full_section=true round-trip with destructive-change confirmation
- Per-server health check parameter editing (check enable, interval,
  fall, rise, weight)
- ACL line management per frontend/backend
- HTTP request rules (redirect 301/302/307/308, deny 403/404) with
  optional conditions
- Log target management per frontend/backend
- HAProxy auth userlist management (lists + users)
- DNS resolver management (nameservers, payload size, hold tuning)
- Runtime map files and key/value entries (live, no reload)
- Read-only stick tables viewer with pagination
- SSL certificate storage management with X.509 parsing
  (subject/issuer/expiry) and expiry badges
- Multi-node config sync (skip/overwrite conflict strategies,
  per-target transactions) and node-to-node config drift detection
- Config bundle export/import (JSON)

#### Operations
- Live runtime stats tab and native traffic statistics with 24h SVG
  trend charts (5-minute sampling, 30-day retention)
- Fleet health dashboard: per-node latency history bars, server UP
  counts, down-node and not-UP-server alerts
- Webhook notifications on node down/recovery transitions with
  cooldown and test-send
- Read-only service topology view (frontend → backend → servers,
  colored by runtime state)
- Runtime server state control (ready/drain/maint) without reload
- Config change history with LCS diffs, one-click revert, retention
  policy and actor attribution
- Background maintenance scheduler: history purge, health-check and
  metric-sample trimming, optional daily config backups

#### Platform
- TanStack Start (React 19) SSR app; Tailwind CSS 4; ReUI/shadcn-style
  components
- SQLite persistence (`node:sqlite`) with idempotent schema migrations
- Session authentication (signed HttpOnly cookie, login page, logout
  revocation, login rate limiting) plus env single-user bootstrap
- Multi-user accounts with `admin`/`viewer` roles (scrypt password
  hashing, user management UI, last-admin protection)
- API bearer tokens for automation (hash-only storage, mint-once,
  instant revocation)
- CSRF same-origin enforcement and security response headers
- AES-256-GCM encrypted credential storage with startup migration
- Server-sent events pushing changes, status flips and user changes
  to the UI (polling fallback retained)
- Global RBAC middleware (viewer read-only) covering pages and APIs
- Production Node server (`scripts/prod-server.mjs`), multi-stage
  Dockerfile, GitHub Actions CI (lint/typecheck/test/build + prod
  smoke + Playwright E2E)

#### Testing
- 70 vitest unit tests (schemas, diff, db, crypto, proxy, normalize)
- API integration suite (`npm run itest`)
- 16-scenario Playwright browser suite across admin/viewer roles
- End-to-end verification against a real HAProxy 3.3 + dataplaneapi
  v3.4 container (19 assertions)

### Fixed
- Real-container compatibility: dataplaneapi execs reload commands
  without a shell (container reload fix via reload.sh); servers are
  not embedded in backends collections (per-backend fetch);
  /runtime/backends collection absent (configuration list used)
- `/nodes/$id` rendered the nodes list instead of the detail page
  (missing Outlet on the layout route)
- Nameless config rows crashing name-based filtering
- Client build import-protection violation for server modules in the
  root route (resolved via global request middleware)

### Security
- Node credentials encrypted at rest (AES-256-GCM, HAPROXY_UI_KEY)
- Session cookies HttpOnly/SameSite=Lax (+ optional Secure), signed
  tokens with runtime revocation
- CSRF same-origin enforcement and security response headers

[2.0.0]: https://github.com/republicroad/haproxy-ui/releases/tag/v2.0.0
[1.2.0]: https://github.com/republicroad/haproxy-ui/releases/tag/v1.2.0
[1.1.0]: https://github.com/republicroad/haproxy-ui/releases/tag/v1.1.0
[1.0.0]: https://github.com/republicroad/haproxy-ui/releases/tag/v1.0.0
