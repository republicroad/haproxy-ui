# [![v2.0.0](https://img.shields.io/badge/version-2.0.0-blue)](CHANGELOG.md)

# HAProxy UI

A self-hosted management UI for HAProxy fleets, built on the official
[HAProxy Data Plane API](https://github.com/haproxytech/dataplaneapi)
(v3). Manage nodes, edit configuration, monitor health and traffic, and
roll back changes — all through one web interface.

Built with TanStack Start (React 19), Tailwind CSS 4, TanStack
Query/Table, `node:sqlite`, and zod.

## Features

- **Node registry** — register HAProxy instances (name, Data Plane API
  URL, credentials), one-click connectivity tests, auto-refreshing
  status, bulk "test all".
- **Configuration management** — create/edit/delete frontends, backends
  and their servers inside validated transactions (`haproxy -c` + graceful
  reload). Section edits never touch neighbouring objects.
- **Runtime server control** — set `ready` / `drain` / `maint` per server
  at runtime (zero-downtime deploys, no reload).
- **Traffic dashboard** — live per frontend/backend/server stats
  (sessions, request rates, bytes in/out, response-code breakdown) from
  the native stats API.
- **ACL management** — add/remove ACL lines on any frontend/backend,
  applied through transactions and recorded in history.
- **Rules engine** — HTTP request rules (redirect, deny, set/add/del
  header), HTTP response rules, TCP request rules, `use_backend`
  switching rules, backend active health-check expectations
  (`http-check expect`) and a one-click per-client-IP **rate limit
  preset** (stick-table + track-sc0 + deny) — all inside validated
  transactions.
- **WAF & bot management** — HAProxy-native protection bundles
  (SQLi/XSS/path-traversal/scanner-UA/dangerous-method presets, custom
  regex rules, blocked-bot signatures and a verified-bots allowlist).
  Every toggle compiles to named ACL lines + one deny rule, so no
  sidecar daemons are involved.
- **Access-log explorer** — optional UDP syslog receiver ingests
  HAProxy access logs (sampling + retention) with a filterable
  request tab per node, plus SQL-side aggregations: status-class
  totals, per-5-minute request trend, top clients and per-frontend
  breakdown.
- **Runtime maps** — inspect and edit stick-table-driven map files
  (key/value CRUD, applies live without reload).
- **Auth userlists & DNS resolvers** — manage HAProxy Basic-Auth
  userlists (lists + users) and DNS resolvers (nameservers, hold
  tuning) for FQDN server pools.
- **Service topology** — read-only SVG map of frontends → backends →
  servers, colored by runtime health state.
- **Stick tables** — read-only viewer with pagination for runtime stick
  table entries.
- **Automation API** — admin-minted bearer tokens (hash-only storage,
  instant revocation) let CI/curl scripts call the same REST API the
  UI uses.
- **Change history** — every configuration change is recorded with a raw
  config snapshot and the acting user; LCS-based diffs and one-click
  revert (create ⇄ delete) via a validated transaction.
- **Review before apply** — opt-in per node: every config transaction
  pauses before commit and shows the staged raw-config diff for
  approval (cancel rolls the transaction back).
- **HTTP request rules** — manage redirect and deny rules per
  frontend/backend with optional conditions, transactional and recorded.
- **Audit attribution** — when authentication is enabled, every change is
  attributed to the signed-in user (visible in the History tab).
- **Multi-node sync** — push selected frontends/backends (with servers)
  from one node to many, with per-target transactions and skip/overwrite
  conflict handling; optionally carries each section's WAF & bot rules
  (named ACL bundles + deny rules) along, idempotently.
- **Config drift detection** — compare the configuration of any two nodes
  (missing/extra objects, changed fields, server-set differences).
- **Import/export** — export/import node registries (credentials
  stripped) and full per-node config bundles (JSON).
- **Fleet health dashboard** — per-node status with latency history bars,
  server UP counts, and down-node/not-UP-server alerts.
- **Alert webhooks & email** — POST notifications (Slack/Discord/generic)
  and SMTP emails on node down/recovery transitions and **expiring
  certificates** (daily scan, `HAPROXY_UI_CERT_WARN_DAYS` threshold,
  per-certificate cooldown), with "send test" buttons for both channels.
- **Security** — optional session-based authentication (signed HttpOnly
  cookie, login page, logout revocation, login rate limiting),
  AES-256-GCM encrypted credential storage at rest, and multi-user
  accounts with `admin`/`viewer` roles (viewer is read-only, last-admin
  protection, user management UI). **OIDC/SSO** sign-in for enterprise
  identity providers (discovery + RS256 JWKS verification, e-mail
  based provisioning with admin mapping).
- **Prometheus endpoint** — `/api/metrics` exposes fleet health, node
  versions and the latest sampled stats in the Prometheus text format.
- **Upgrade orchestration** — per-node HAProxy binary upgrade wizard:
  config snapshot (rollback artifact), optional server drain, then
  version verification against the target with a run history.
- **OpenAPI spec** — `/api/openapi` serves a 3.1 document with
  schemas generated from the same zod validators the API uses.
- **Automation API** — admin-minted bearer tokens (hash-only storage,
  copy-once, instant revocation) let CI/curl scripts call the same
  REST API the UI uses. Tokens carry a **scope**: full access,
  read-only (no writes at all), or restricted to a single node group.
- **Session management** — active sessions (user, IP, agent, last
  activity) are listed and individually revocable; logout revokes only
  the caller's session.
- **Group admins** — admin-role users can be pinned to a node group and
  then only manage nodes of that group (fleet-wide endpoints denied).
- **IP access control** — bulk CIDR/hostname allow & deny lists per
  frontend/backend ("block listed sources" / "allow only listed
  sources"); paste country CIDR lists for geo blocking. Carried along
  by multi-node sync.
- **Config advisor** — static best-practice findings per node: broken
  backend references, servers without health checks, track-sc rules
  without stick-tables, orphaned objects, missing log targets.
- **SPOE/Coraza generator** — ready-made snippets to attach a Coraza
  (ModSecurity-compatible) deep-inspection agent to any frontend.
- **Live updates** — server-sent events push config changes, node status
  flips and user changes to the UI; polling remains as a fallback.
- **Retention & backups** — hourly maintenance loop purges change
  history past the retention window, trims health-check history, and
  (optionally) writes daily config backups to disk.

## Getting started

Requirements: **Node ≥ 22.5** (`node:sqlite`), npm.

```bash
npm install
npm run dev          # dev server on :3000
```

Open http://localhost:3000 and register a node pointing at a Data Plane
API (e.g. `http://localhost:5555`, admin/admin for the bundled dev
containers).

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `HAPROXY_UI_DB` | `./haproxy-ui.db` | SQLite database path |
| `HAPROXY_UI_USER` / `HAPROXY_UI_PASS` | *(unset)* | Enable session auth when both are set |
| `HAPROXY_UI_SECRET` | derived | HMAC secret for session tokens |
| `HAPROXY_UI_KEY` | *(unset)* | Enable AES-256-GCM credential encryption at rest |
| `HAPROXY_UI_RETENTION_DAYS` | `30` | Change-history retention (hourly purge) |
| `HAPROXY_UI_HEALTH_KEEP` | `720` | Max health-check rows per node |
| `HAPROXY_UI_BACKUP_DIR` | *(unset)* | Enable daily config backups to this directory |
| `HAPROXY_UI_MAINTENANCE` | `on` | Set `off` to disable the background scheduler |
| `HAPROXY_UI_LOG_PORT` | *(unset)* | UDP port for the HAProxy access-log receiver |
| `HAPROXY_UI_LOG_SAMPLE` | `100` | Access-log sampling percent (1-100) |
| `HAPROXY_UI_LOG_KEEP` | `24` | Access-log retention hours |
| `HAPROXY_UI_CERT_WARN_DAYS` | `30` | Certificate expiry alert threshold (daily scan) |
| `HAPROXY_UI_OIDC_ISSUER` | *(unset)* | OIDC issuer (enables SSO with client id/secret) |
| `HAPROXY_UI_OIDC_CLIENT_ID` / `_SECRET` | *(unset)* | OIDC client credentials |
| `HAPROXY_UI_OIDC_ADMIN_EMAILS` | *(unset)* | Comma list of e-mails that get the admin role |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Production server bind (prod-server.mjs) |

## Production

```bash
npm run build
node scripts/prod-server.mjs        # serves dist/ (SSR + client assets)
```

Docker:

```bash
docker build -t haproxy-ui .
docker run -p 3000:3000 -v haproxy-ui-data:/app/data \
  -e HAPROXY_UI_USER=admin -e HAPROXY_UI_PASS=secret \
  -e HAPROXY_UI_KEY=change-me haproxy-ui
```

### Backing up the UI database

The UI is stateful (SQLite). Three layers, pick what fits:

1. **One-click snapshots** — Users page (admin) → *Database backups* →
   *Backup now*, or `POST /api/db/backup` (Bearer token). Files are
   consistent, online `VACUUM INTO` copies written to
   `HAPROXY_UI_BACKUP_DIR` (default `./backups`).
2. **Restore** — stop the app, replace the DB file with the snapshot,
   start again. Snapshots are plain SQLite files.
3. **Continuous** — point [litestream](https://litestream.io) at the
   same DB file (`databases: [{path: /app/data/haproxy-ui.db, ...}]`);
   it replicates every WAL frame to S3/SSH/GCS in near-real-time.

## Development environment (HAProxy + Data Plane API)

A two-node HAProxy + Data Plane API stack for local development:

```bash
podman compose up -d hap1 hap2
# dataplaneapi: http://localhost:5555 and :5556 (admin / admin)
```

A mock dataplaneapi (`scripts/mock-dataplaneapi.mjs`) covers most
endpoints without containers:

```bash
node scripts/start-bg.mjs --pidfile mock.pid --name mock -- \
  node scripts/mock-dataplaneapi.mjs
```

See [docs/bg-processes.md](docs/bg-processes.md) for the detached-process
conventions used in this repo.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the dev server on :3000 |
| `npm run build` | Production build (outputs to `dist/`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (flat config) |
| `npm run format` | Prettier |
| `npm run test` | Vitest unit tests (schemas, diff, db, crypto, proxy) |
| `npm run itest` | API integration test against a running app (:3000) + dataplaneapi (`DP_PORT`, default 9090) |
| `npx playwright test` | Browser E2E suite (spins up its own server + mock) |

## Architecture

```
Browser ─┬─ /api/nodes (CRUD, test, export/import, diff) ──> TanStack Start server ──> node:sqlite
         ├─ /api/health/summary (probes + history + alerts) ─┘        │
         ├─ /api/auth/* (session login/logout/status) ────────────────┤
         └─ /api/dp/:nodeId/* (BFF proxy, credentials injected) ──────┴──> {node.apiUrl}/v3/*
```

- `src/routes/api/**` — server API routes (nodes, changes+revert, config
  export/import, diff, health, alerts, auth, BFF proxy)
- `src/lib/db` — SQLite access (nodes, config_changes + actor,
  health checks, alert settings/state)
- `src/lib/auth.ts` — session tokens, cookie handling, rate limiting,
  audit actor resolution
- `src/lib/crypto.ts` — AES-256-GCM credential encryption
- `src/lib/maintenance.ts` — hourly retention/backup scheduler
- `src/lib/dataplane/` — BFF proxy (server) + typed client with
  transaction helper (browser)
- `src/lib/normalize.ts` — v2/v3 servers & binds shape compatibility
- `src/middleware.ts` — global request guard (session auth)
- `src/components/` — app components, shadcn-style `ui/` primitives,
  vendored `reui/` blocks

## Roadmap

- Anomaly alerts from ingested access logs (spike/5xx detection)
- OIDC group-claim → node-group mapping for SSO-managed group admins