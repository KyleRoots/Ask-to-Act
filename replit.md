# Bullhorn ATS MCP Server

A remote Model Context Protocol (MCP) server that connects any MCP-compatible AI (ChatGPT, Claude, Gemini, Grok) to Bullhorn ATS. Recruiters enable the Bullhorn connector inside their AI and can both read live ATS data and write back to it through natural language — search, submit, note, update statuses, manage jobs/companies/contacts, record placements, upload résumés — without leaving the AI. Reads run on a shared, cacheable service-account session; every write runs under the recruiter's own Bullhorn OAuth session with their permission gates enforced.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API/MCP server (port from `$PORT`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-server run golden` — golden-answer harness: calls every report tool + count_entity against live Bullhorn and asserts invariants + cross-tool consistency (same metric identical across tools) + snapshot drift. Read-only. `--bless` re-baselines the snapshot, `--strict` fails on drift. This is the robustness scoreboard / stop-signal.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API/MCP: Express 5 + `@modelcontextprotocol/sdk` v1.29
- Auth: Bullhorn OAuth 2.0 authorization_code flow + rotating refresh tokens (persisted in Postgres) → BhRestToken session
- Validation: Zod v3, `drizzle-zod`
- Build: esbuild (ESM bundle)

## Where things live

- `artifacts/api-server/src/lib/bullhorn-auth.ts` — Bullhorn OAuth + session lifecycle (singleton)
- `artifacts/api-server/src/lib/bullhorn-client.ts` — all Bullhorn API operations: read (search/query/get primitives + curated helpers) and write (create/update entities, file upload) with server-side field validation, picklist checks, and duplicate guards
- `artifacts/api-server/src/lib/mcp-server.ts` — MCP server factory: 33 read tools + 20 Bullhorn write tools (writes via resolveWriteSession/runWriteTool, never cached, 403 → permission_denied). Writes are MCP-connector-only — never exposed on the REST /api/v1 or public OpenAPI surface
- `artifacts/api-server/src/lib/cache.ts` — short-TTL in-memory response cache for read tools
- `artifacts/api-server/src/routes/mcp.ts` — Express route mounting the MCP server (POST + GET /api/mcp)
- `artifacts/api-server/src/middlewares/bearer-auth.ts` — shared secret bearer token validation
- `artifacts/api-server/README.md` — full ops guide and ChatGPT Enterprise registration steps

## Architecture decisions

- **Stateless MCP**: A fresh `McpServer` + `StreamableHTTPServerTransport` is created per request. This avoids session state on the server and works correctly with ChatGPT Enterprise's stateless MCP app model.
- **Response cache**: A process-wide short-TTL LRU cache (`cache.ts`) sits in front of the read tools, keyed by tool name + full arguments (incl. `fields`). It is a module-level singleton shared across the per-request MCP servers, so repeated identical reads skip the Bullhorn round-trip. Only successful results are cached; errors propagate uncached. Configurable via `CACHE_TTL_MS` (default 60000) and `CACHE_MAX_ENTRIES` (default 500); set TTL to 0 to disable.
- **Auth model**: Read tools run on a shared service-account Bullhorn session (simple, cacheable). Write tools run under each recruiter's own per-user Bullhorn OAuth session, so Bullhorn's own permission gates enforce what each user can do and every write is attributable in the audit trail. Writes are never cached and surface a 403 from Bullhorn as `permission_denied`.
- **Bearer token security**: `MCP_BEARER_TOKEN` is the only access gate. All requests without it return 401. No IP allowlisting yet (v2 option after OpenAI publishes stable egress IP ranges).
- **In-memory rate limiting**: `express-rate-limit` with configurable window/max via env vars. No Redis dependency for v1.
- **Bullhorn session management**: Sessions are built from a rotating refresh token (persisted in Postgres); on failure it falls back to a headless authorization_code login (guarded by a cooldown to avoid API-user lockout). Session is invalidated on 401 responses from the API.

## Product

Recruiters enable the Bullhorn connector in their AI (ChatGPT, Claude, Gemini, or Grok) and can immediately ask: "Find candidates in Chicago with .NET experience", "What are the open jobs at Acme Corp?", "Submit candidate #123 to job #456 and add a note." 33 read tools span dedicated entity tools (candidates, jobs, companies, contacts, submissions, placements, notes, leads, opportunities, appointments, tasks, users), reporting tools, and generic fallbacks (search_entity, query_entity, get_entity, describe_entity). 20 write tools cover submissions and status changes, notes, job/company/contact create+update, tasks and appointments, tearsheet curation, placements, and file/résumé upload with new-candidate creation — each under the recruiter's own OAuth session.

## Required environment variables (set in Replit Secrets)

- `MCP_BEARER_TOKEN` — shared secret sent by ChatGPT Enterprise with every request
- `BULLHORN_CLIENT_ID` — Bullhorn API client ID
- `BULLHORN_CLIENT_SECRET` — Bullhorn API client secret
- `BULLHORN_USERNAME` — service account username
- `BULLHORN_PASSWORD` — service account password
- `PORT` — set automatically by Replit
- `RATE_LIMIT_MAX` (optional) — max requests per window, default 120
- `RATE_LIMIT_WINDOW_MS` (optional) — window size in ms, default 60000
- `CACHE_TTL_MS` (optional) — read-cache entry lifetime in ms, default 60000 (set 0 to disable)
- `CACHE_MAX_ENTRIES` (optional) — max cached read responses, default 500
- `BULLHORN_UI_BASE_URL` (optional) — base URL used to build record deep links; defaults to the UI cluster derived from the REST swimlane (e.g. `rest45...` → `https://cls45.bullhornstaffing.com`). Set this only if the instance's UI host differs.

## Gotchas

- Always run `pnpm install` after adding packages before building
- The MCP endpoint is at `/api/mcp` (not `/mcp`) — the `/api` prefix comes from `app.ts`
- Bullhorn uses swimlane-specific `restUrl` values — the auth module discovers the correct one automatically via the `/login` response
- Bullhorn search uses Lucene syntax; entity queries use SQL WHERE syntax — different endpoints (`search/` vs `query/`)
- Session tokens expire; the auth module auto-refreshes from a persisted refresh token, falling back to a headless authorization_code login on failure
- `MCP_BEARER_TOKEN` must be set or the server will return 503 on all MCP requests
- Read results for Candidate/ClientContact/ClientCorporation/JobOrder/Lead/Opportunity records include a `bullhornUrl` deep link (`OpenWindow.cfm`) so the AI can link straight to the record. The host is derived from the REST swimlane by default; override with `BULLHORN_UI_BASE_URL` if the instance moves clusters. Transactional entities (submissions, placements, notes, tasks, etc.) intentionally get no link.

## Deployment

- Deploy as a **Reserved VM** (always-on) so the in-memory Bullhorn session and read cache persist and there is no cold-start auth on the first call after idle. Autoscale would scale to zero and reintroduce cold starts.
- Production config lives in `artifacts/api-server/.replit-artifact/artifact.toml`: build = `pnpm --filter @workspace/api-server run build`, run = `node dist/index.mjs`, `PORT=8080`, startup health check at `/api/healthz`.
- After publishing, repoint the ChatGPT connector to `https://<deployment-domain>/api/mcp` (bearer `MCP_BEARER_TOKEN`).

## Pointers

- See `artifacts/api-server/README.md` for full ChatGPT Enterprise registration instructions
- See the `pnpm-workspace` skill for workspace structure and TypeScript setup details
