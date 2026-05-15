# Bullhorn ATS MCP Server

A remote Model Context Protocol (MCP) server that connects ChatGPT Enterprise to Bullhorn ATS. Recruiters toggle the Bullhorn app on inside ChatGPT and can search and retrieve live ATS data through natural language — without leaving ChatGPT. No UI, pure middleware.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API/MCP server (port from `$PORT`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API/MCP: Express 5 + `@modelcontextprotocol/sdk` v1.29
- Auth: Bullhorn OAuth 2.0 password grant → BhRestToken session
- Validation: Zod v3, `drizzle-zod`
- Build: esbuild (ESM bundle)

## Where things live

- `artifacts/api-server/src/lib/bullhorn-auth.ts` — Bullhorn OAuth + session lifecycle (singleton)
- `artifacts/api-server/src/lib/bullhorn-client.ts` — all 11 read-only Bullhorn API operations
- `artifacts/api-server/src/lib/mcp-server.ts` — MCP server factory with all tool definitions
- `artifacts/api-server/src/routes/mcp.ts` — Express route mounting the MCP server (POST + GET /api/mcp)
- `artifacts/api-server/src/middlewares/bearer-auth.ts` — shared secret bearer token validation
- `artifacts/api-server/README.md` — full ops guide and ChatGPT Enterprise registration steps

## Architecture decisions

- **Stateless MCP**: A fresh `McpServer` + `StreamableHTTPServerTransport` is created per request. This avoids session state on the server and works correctly with ChatGPT Enterprise's stateless MCP app model.
- **Service-account auth (v1)**: One shared Bullhorn session for all ChatGPT users. Simpler to operate; per-user OAuth deferred to v2 when write tools are added and audit trail matters.
- **Bearer token security**: `MCP_BEARER_TOKEN` is the only access gate. All requests without it return 401. No IP allowlisting yet (v2 option after OpenAI publishes stable egress IP ranges).
- **In-memory rate limiting**: `express-rate-limit` with configurable window/max via env vars. No Redis dependency for v1.
- **Bullhorn session management**: Token refresh is attempted automatically; falls back to full password grant on failure. Session is invalidated on 401 responses from the API.

## Product

Recruiters in ChatGPT Enterprise toggle the Bullhorn app on and can immediately ask: "Find candidates in Chicago with .NET experience", "What are the open jobs at Acme Corp?", "Show me submissions for job #456." All 11 read-only tools (search_candidates, search_jobs, search_companies, search_contacts, get_candidate, get_job, get_company, get_contact, list_submissions_for_job, list_placements, get_notes) are available.

## Required environment variables (set in Replit Secrets)

- `MCP_BEARER_TOKEN` — shared secret sent by ChatGPT Enterprise with every request
- `BULLHORN_CLIENT_ID` — Bullhorn API client ID
- `BULLHORN_CLIENT_SECRET` — Bullhorn API client secret
- `BULLHORN_USERNAME` — service account username
- `BULLHORN_PASSWORD` — service account password
- `PORT` — set automatically by Replit
- `RATE_LIMIT_MAX` (optional) — max requests per window, default 120
- `RATE_LIMIT_WINDOW_MS` (optional) — window size in ms, default 60000

## Gotchas

- Always run `pnpm install` after adding packages before building
- The MCP endpoint is at `/api/mcp` (not `/mcp`) — the `/api` prefix comes from `app.ts`
- Bullhorn uses swimlane-specific `restUrl` values — the auth module discovers the correct one automatically via the `/login` response
- Bullhorn search uses Lucene syntax; entity queries use SQL WHERE syntax — different endpoints (`search/` vs `query/`)
- Session tokens expire; the auth module auto-refreshes but a cold start will always do a full password grant first
- `MCP_BEARER_TOKEN` must be set or the server will return 503 on all MCP requests

## Pointers

- See `artifacts/api-server/README.md` for full ChatGPT Enterprise registration instructions
- See the `pnpm-workspace` skill for workspace structure and TypeScript setup details
