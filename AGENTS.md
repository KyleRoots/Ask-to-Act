# AGENTS.md

## Cursor Cloud specific instructions

This repo is a **pnpm workspace monorepo**. The only runtime backend product is the
**Bullhorn ATS MCP Server** (`artifacts/api-server`) — a headless Model Context Protocol
server (no UI) that connects ChatGPT Enterprise to Bullhorn ATS. It requires a PostgreSQL
database (used to persist rotating Bullhorn OAuth refresh tokens). The three Vite apps under
`artifacts/*` (`pitch-deck`, `exec-summary`, `mockup-sandbox`) are optional marketing/design
collateral, not part of the runtime product.

Standard commands live in `artifacts/api-server/README.md`, `replit.md`, and `package.json`
scripts — prefer those instead of re-deriving them. Key notes below are the non-obvious bits.

### Local services (already provisioned in the VM snapshot)

- **PostgreSQL 16** runs as a local cluster. Start it (idempotent) before running anything
  that touches the DB: `sudo pg_ctlcluster 16 main start`.
- A database named `bullhorn` exists with user/password `postgres`/`postgres`.
  Connection string: `postgresql://postgres:postgres@localhost:5432/bullhorn`.

### Required env vars to run the API server

The server (and `@workspace/db`) **throw on startup if these are unset** — there are no
defaults and no `.env` file in the repo:

- `DATABASE_URL` — e.g. `postgresql://postgres:postgres@localhost:5432/bullhorn`
- `PORT` — e.g. `5000` (no default; the process exits if missing)
- `MCP_BEARER_TOKEN` — any shared secret; without it every `/api/mcp` and `/api/v1`
  request returns `503`/`401`. For local dev any non-empty string works.

The four `BULLHORN_*` vars (CLIENT_ID/CLIENT_SECRET/USERNAME/PASSWORD) are only needed for
live data — see the Bullhorn caveat below.

### Database schema

Apply the Drizzle schema after Postgres is up (not part of the dependency-refresh update
script because it is a migration that needs a live DB + `DATABASE_URL`):
`DATABASE_URL=... pnpm --filter db push`

### Run the API server (dev)

```
sudo pg_ctlcluster 16 main start
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/bullhorn"
export MCP_BEARER_TOKEN="dev-secret-token-12345"
export PORT=5000
pnpm --filter @workspace/api-server run dev   # = build (esbuild) then start; NOT hot-reload
```

Verify: `curl http://localhost:5000/api/healthz` → `{"status":"ok"}`. The MCP endpoint is at
`/api/mcp` (note the `/api` prefix), and the REST surface is at `/api/v1/*` (bearer-protected).

### Bullhorn external dependency caveat (important for testing)

Bullhorn ATS is a third-party SaaS and is **not** available locally. The Bullhorn session is
**lazy** — the server starts fine without credentials, and MCP `tools/list` + `GET /api/v1/reports`
(report library listing) work with no Bullhorn connection. Any tool/endpoint that actually
fetches ATS data (e.g. `search_candidates`, `count_entity`, the report-running endpoints) needs
real `BULLHORN_*` credentials and a completed one-time OAuth authorization, and will otherwise
return a "Bullhorn is not connected" error. Use `tools/list` and `/api/v1/reports` as the
credential-free smoke test of the MCP/HTTP layer.

### Build / lint / typecheck notes

- Typecheck everything: `pnpm run typecheck` (passes).
- Build the product: `pnpm --filter @workspace/api-server run build` (esbuild → `dist/index.mjs`).
- `pnpm run build` at the repo root **fails** on the optional Vite apps (`pitch-deck`,
  `mockup-sandbox`, `exec-summary`) because their `vite.config.ts` reads `PORT` at config-load
  time and throws if unset. To build/run a Vite app, export `PORT` first (e.g.
  `PORT=18522 pnpm --filter @workspace/pitch-deck run dev`). The api-server build is unaffected.
- There is **no ESLint and no automated test suite**. `prettier` is installed but the repo is
  not fully prettier-formatted, so `prettier --check .` reports pre-existing style diffs across
  many files (including generated code) — this is expected and not an error you introduced.
- **pnpm is mandatory** — a `preinstall` guard rejects npm/yarn.
