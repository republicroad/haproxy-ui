# [![v1.0.0](https://img.shields.io/badge/version-1.0.0-blue)](CHANGELOG.md)

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
- **HTTP request rules** — manage redirect and deny rules per
  frontend/backend with optional conditions, transactional and recorded.
- **Audit attribution** — when authentication is enabled, every change is
  attributed to the signed-in user (visible in the History tab).
- **Multi-node sync** — push selected frontends/backends (with servers)
  from one node to many, with per-target transactions and skip/overwrite
  conflict handling.
- **Config drift detection** — compare the configuration of any two nodes
  (missing/extra objects, changed fields, server-set differences).
- **Import/export** — export/import node registries (credentials
  stripped) and full per-node config bundles (JSON).
- **Fleet health dashboard** — per-node status with latency history bars,
  server UP counts, and down-node/not-UP-server alerts.
- **Alert webhooks** — POST notifications (Slack/Discord/generic) on
  node down/recovery transitions, with a 5-minute cooldown and a
  "send test" button.
- **Security** — optional session-based authentication (signed HttpOnly
  cookie, login page, logout revocation, login rate limiting),
  AES-256-GCM encrypted credential storage at rest, and multi-user
  accounts with `admin`/`viewer` roles (viewer is read-only, last-admin
  protection, user management UI).
- **Automation API** — admin-minted bearer tokens (hash-only storage,
  copy-once, instant revocation) let CI/curl scripts call the same
  REST API the UI uses.
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

- Access-log ingestion and request explorer (cost/benefit under evaluation)
- OIDC/SSO integration for enterprise identity providers
- HAProxy binary upgrade orchestration