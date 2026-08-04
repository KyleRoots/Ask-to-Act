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
Shared start/poll runner: `artifacts/api-server/src/lib/report-jobs.ts`
(`startReportJob` + per-tool wrappers).

## Tools on the contract today

| Sync tool | MCP start | REST start | REST poll |
|-----------|-----------|------------|-----------|
| `scout_dept_report` | `start_scout_dept_report_job` | `POST /reports/scout-qualified-by-department/jobs` | `GET /reports/jobs/{jobId}` |
| `match_candidates_for_job` | `start_match_candidates_job` | `POST /sourcing/match-candidates-for-job/jobs` | same |
| `recruiter_leaderboard` | `start_recruiter_leaderboard_job` | `POST /reports/recruiter-leaderboard/jobs` | same |

Match also has sync REST: `POST /sourcing/match-candidates-for-job`.

## Non-goals (next rung)

- Durable workers / survive deploy (in-process `void run()` today)
- Multi-tenant cron rewrite
- Raising sync soft walls
- Wrapping every paged search tool

## Host rules

- Never date-window fan-out for scout.
- Never give up solely because of `wall_time`.
- Present partials; continue via MCP **or** REST from `asyncContinuation`.
