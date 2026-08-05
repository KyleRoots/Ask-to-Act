---
name: Custom GPT Actions surface
description: Why AskToAct exposes a public read-only OpenAPI Actions doc alongside the MCP connector, and the auth/identity tradeoff.
---

AskToAct offers TWO onboarding paths for ChatGPT, not one:
- **MCP connector** (per-user URL with embedded apiKey) — the production path. Read **and** write (notes, status, submittals), attributed to each recruiter's own Bullhorn identity.
- **Custom GPT with Actions** — read-only reporting subset only. Imports a public OpenAPI doc; auth is a Bearer API key entered in the GPT editor.

**Why the schema is served publicly (unauthenticated):** the discovery doc (`/api/openapi.json`) and system prompt (`/api/gpt/instructions`) only DESCRIBE the API; every operation they list is still `bearerAuth`-gated under `/api/v1`. ChatGPT fetches the schema during GPT setup without a token, so it must live outside the auth gate. The doc is non-sensitive.

**Identity/audit tradeoff to always surface:** a *shared* Custom GPT runs every query under the single key configured in it — all usage collapses to one audit principal. For per-person attribution, each teammate must build their own GPT with their own key. The MCP connector is inherently per-user, which is why it's the recommended production path.

**How to apply:** keep the Actions spec a strict read-only subset; never add write ops to it (writes belong on the MCP connector where identity is per-user). Keep the spec's `servers[0].url` = `getBaseUrl()+"/api/v1"` in lockstep with the mounted v1 routes, or imported actions 404. Keep `lib/api-spec/openapi.yaml` (orval source of truth) in lockstep with `artifacts/api-server/src/routes/openapi.ts` (Actions door).

## Dual-host soft-wall continuation (host-complete)

Sync soft walls stay. On `stopReason=wall_time`, the response always carries
machine-readable `asyncContinuation` that is **host-complete** — both MCP and REST
clients can continue without improvising. Shared poll for all tools:
`get_report_job` / `GET /reports/jobs/{jobId}`.

| Tool | MCP start | REST start |
|------|-----------|------------|
| Scout | `start_scout_dept_report_job` | `POST /reports/scout-qualified-by-department/jobs` |
| Match | `start_match_candidates_job` | `POST /sourcing/match-candidates-for-job/jobs` |
| Recruiter leaderboard | `start_recruiter_leaderboard_job` | `POST /reports/recruiter-leaderboard/jobs` |

Hint text covers both hosts. **Never** date-window fan-out (scout). **Never** give up on `wall_time`.
See [universal-async-jobs.md](./universal-async-jobs.md) and [scout-qualified-by-department.md](./scout-qualified-by-department.md).

**Host setup reminders (docs-only):** Custom GPT Actions use the REST half of
`asyncContinuation` (MCP start_* tools are invisible there). Prefer per-user MCP
connectors over one shared GPT key. Cursor ops secrets: service bearer for
`ASKTOACT_MCP_API_KEY` when calling ops-health — user keys 403 on ops routes
([asktoact-mcp-api-key.md](./asktoact-mcp-api-key.md)).
