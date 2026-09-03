# HAProxy UI

A lightweight web UI for managing a fleet of HAProxy instances through the
[HAProxy Data Plane API](https://github.com/haproxytech/haproxy-dataplane-api).

Built with [TanStack Start](https://tanstack.com/start) (React 19, Vite),
Tailwind CSS 4, TanStack Query/Table, and Node's built-in SQLite (`node:sqlite`,
requires **Node ≥ 22.5**).

## Features

- **Node registry** — register HAProxy nodes (name + Data Plane API URL + Basic
  credentials), edit and delete them, with automatic status refresh.
- **Connection test** — single-node and batch "Test all"; persists `status`,
  `lastSeen`, and the detected HAProxy version.
- **Secure BFF proxy** — all Data Plane API calls go through `/api/dp/:nodeId/*`
  on the server, so node credentials never reach the browser.
- **Transactional configuration** — frontends, backends, and backend servers are
  created/deleted inside dataplaneapi transactions (validated config +
  graceful reload on commit, rollback on failure).
- **Raw config viewer** and runtime info panel with auto-refresh.

## Getting started

```bash
npm install
npm run dev        # http://localhost:3000
```

The SQLite database is created on first run (`haproxy-ui.db`, override with the
`HAPROXY_UI_DB` environment variable).

## Development environment (HAProxy + Data Plane API)

`docker-compose.yml` starts two HAProxy nodes (`hap1`, `hap2`) built from
`haproxy/Containerfile` (HAProxy + bundled `dataplaneapi` binary):

```bash
podman compose build
podman compose up -d
# dataplaneapi: http://localhost:5555 and :5556 (admin / admin)
```

For lightweight testing without containers, an in-memory mock of the Data Plane
API is included:

```bash
node scripts/mock-dataplaneapi.mjs   # listens on :9090 (admin / admin)
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start the dev server on :3000 |
| `npm run build` | Production build (outputs to `dist/`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (flat config) |
| `npm run format` | Prettier |
| `npm run itest` | Integration test against a running app (:3000) and dataplaneapi (`DP_PORT`, default 5555) |

## Architecture

```
Browser ── /api/nodes (CRUD, test) ──> TanStack Start server ──> node:sqlite (registry)
        └─ /api/dp/:nodeId/* (BFF) ──> {node.apiUrl}/v3/* (Basic auth injected server-side)
```

- `src/routes/api/**` — server API routes (node CRUD, connection test, BFF proxy)
- `src/lib/db` — SQLite access (single `nodes` table)
- `src/lib/schemas.ts` — zod schemas shared by API validation and forms
- `src/lib/dataplane/` — BFF proxy (server) + typed client with transaction helper (browser)
- `src/components/` — app components, shadcn-style `ui/` primitives, vendored `reui/` blocks

## Roadmap

- HAProxy stats page (8404 CSV / runtime maps)
- Config change history with diff + rollback
- Multi-node config sync, ACL/Maps management
- App-level authentication, encrypted credential storage
