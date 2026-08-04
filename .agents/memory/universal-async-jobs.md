# Universal soft-wall → async job contract

Soft walls are **channel realism** for ChatGPT/gateway (~95s sync). They are
**never** raised on sync MCP/REST paths and **never** a dead end.

## Pattern (all opted-in tools)

1. Sync call uses `SYNC_SOFT_WALL_MS` (95s) or scout’s `TOPN_WALL_MS` /
   `EXHAUSTIVE_WALL_MS` (unchanged).
2. On `stopReason=wall_time`, response includes host-complete
   `asyncContinuation`:
   - MCP `tool` (start_*) + `pollTool` (`get_report_job`)
   - REST `rest.start` (POST …/jobs) + `rest.poll` (`GET /reports/jobs/{jobId}`)
   - optional `resumeArgs`
3. Host starts **one** async job with the same args; polls until
   `complete|failed`.
4. Async runner reuses the same engine with `ASYNC_REPORT_WALL_MS` (~20 min
   safety max only). Jobs persist in firm-scoped `report_jobs`
   (`tool_name` + jsonb `args`/`result`).

Shared builders: `artifacts/api-server/src/lib/async-job-contract.ts`.
Shared start/poll: `artifacts/api-server/src/lib/report-jobs.ts`
(`startReportJob` + per-tool wrappers).
Durable worker: `artifacts/api-server/src/lib/report-job-worker.ts`.

## Durable worker (survives redeploy)

Jobs are **not** fire-and-forget in the HTTP request process.

1. `start_*` / REST jobs insert `report_jobs` with `status=queued` and return
   `jobId` immediately (same MCP/REST contracts).
2. api-server boots an in-process poller that **atomically claims** the next
   eligible row (`FOR UPDATE SKIP LOCKED`):
   - `status=queued`, or
   - `status=running` whose `lease_expires_at` is null/expired (crash/redeploy).
3. While running, the owner **heartbeats** (`heartbeat_at` + extends
   `lease_expires_at`). Lease TTL ~120s; heartbeat ~30s.
4. On complete/fail: clear lease fields; persist sanitized jsonb result
   (`sanitizeJsonForPostgres` — strips U+0000).
5. `attempt_count` increments on each claim; after `REPORT_JOB_MAX_ATTEMPTS`
   (default 5) a reclaim marks the job `failed` (poison pill).
6. Per-process concurrency capped by `REPORT_JOB_CONCURRENCY` (default 2).
7. Disable poller with `REPORT_JOB_WORKER=0` (tests / emergency).

No Redis/SQS/Temporal. Separate Railway worker service is optional later if
API latency requires isolation; claim SQL already works across instances.

## Tools on the contract today

| Sync tool | MCP start | REST start | REST poll |
|-----------|-----------|------------|-----------|
| `scout_dept_report` | `start_scout_dept_report_job` | `POST /reports/scout-qualified-by-department/jobs` | `GET /reports/jobs/{jobId}` |
| `match_candidates_for_job` | `start_match_candidates_job` | `POST /sourcing/match-candidates-for-job/jobs` | same |
| `recruiter_leaderboard` | `start_recruiter_leaderboard_job` | `POST /reports/recruiter-leaderboard/jobs` | same |

Match also has sync REST: `POST /sourcing/match-candidates-for-job`.

## Non-goals (later)

- Multi-tenant cron rewrite / snapshot generalization
- Raising sync soft walls
- Wrapping every paged search tool
- Full Temporal/Inngest platform

## Host rules

- Never date-window fan-out for scout.
- Never give up solely because of `wall_time`.
- Present partials; continue via MCP **or** REST from `asyncContinuation`.
