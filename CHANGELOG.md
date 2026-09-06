# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

[1.0.0]: https://github.com/example/haproxy-ui/releases/tag/v1.0.0
