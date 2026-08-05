---
name: Universal connector peak before Stripe + customer #2
description: Status board for confidence ~8.5–9 without live Stripe or a second Bullhorn customer.
---

# Peak before Stripe + customer #2

**Score:** ~8.3–8.6 → **~8.7–8.9** after tranche 2 (staff async + host UX docs)

**Win condition:** Raise production confidence without:

- Live Stripe billing activation
- Standing up a second Bullhorn customer
- Marketplace / ChatGPT store listing

Soft walls stay unchanged (~95s sync; async continuation is the escape hatch).

## Explicitly deferred

| Item | Why deferred |
|------|----------------|
| Stripe live billing | Product/ops decision; keys + webhook + real checkout |
| Customer #2 Bullhorn tenant | Needs corp token + discovery + cron expansion |
| Marketplace listing | GTM timing; not a reliability unlock |
| Broader soft-wall → async wrap | No sync-only tool regularly hits walls in staff use (see §8) |

## Prioritized backlog

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Tenant-safe audit (no Myticas hardcoding in sync/cron/jobs/alerts) | `done` | Code paths firm-scoped; cron URL intentionally single-firm (see below) |
| 2 | Note-snapshot Bullhorn 504 retry/backoff | `done` | Bounded retries on 502/503/504; unit coverage in `bullhorn-transient.test.ts` |
| 3 | Ops aged-failure / thrash reduction | `done` | Failed-job alert lookback 6h → 2h; automation already no-ops on `ok` |
| 4 | Entitlement/subscription hook stubs | `done` | `assertFirmEntitled` + `ENTITLEMENTS_ENFORCED=0` default; plugs into Stripe later |
| 5 | Staff-path reliability (async tools vs walls) | `done` | Live start→poll complete for scout + match; contract tests for wall_time→asyncContinuation |
| 6 | Light security pass (MCP/REST/ops auth) | `done` | Notes below; no auth rewrite |
| 7 | Host UX polish (Custom GPT / secrets) | `done` | Docs-only — secrets + ops-health auth gotcha |
| 8 | Broader async coverage | `deferred` | Rationale in §8 — do not preemptively wrap every paged tool |

## 1. Tenant-safe audit (`done`)

**Findings (2026-08-04):**

- Runtime sync/jobs/alerts resolve firms from DB (`firmId` context, active-firm queries). No hardcoded firm IDs in api-server TypeScript for note-snapshot sync, report_jobs, or ops-health.
- Myticas names appear as **documented fallbacks** (`MYTICAS_DEPT_FIELDS`, `DEPARTMENTS` in reports/scout) for firms without `firm_config` — intentional per [firm-config-resolver.md](./firm-config-resolver.md). Not a cross-tenant leak.
- STSI/MYT-* strings in tool descriptions and tests are **examples**, not filters.

**Intentional single-firm cron (not a code leak):**

Railway service `note-snapshot-cron` startCommand POSTs:

`https://connect.asktoact.ai/api/firms/e44c50e3e95e698c/note-snapshot/sync`

(Myticas firm id). Documented in [scout-note-snapshot-design.md](./scout-note-snapshot-design.md). Expanding to customer #2 = add cron(s) or a multi-firm walker — **deferred** with customer #2. Do not “fix” by inventing multi-tenant cron before a second firm exists.

## 2. Snapshot 504 resilience (`done`)

Note-snapshot harvest walks `getNotes` → `bullhornFetch` association pages. Previously only 401/429 were retried; Bullhorn/gateway **504** failed the department sync.

**Fix:** bounded retries with exponential backoff for HTTP **502/503/504** on read paths (`bullhornFetch` + Lucene `search`). Writes are **not** retried on 5xx (non-idempotent). Helpers: `bullhorn-transient.ts`.

**Tests:** `artifacts/api-server/src/lib/bullhorn-transient.test.ts` (status classification + backoff bounds). Wired into `bullhorn-client.ts` read paths.

## 3. Ops thrash (`done`)

- Automation prompt already: if ops-health `status=ok` → stop, no notify ([ops-alerts.md](./ops-alerts.md)).
- Code: `OPS_FAILED_LOOKBACK_MS` shortened **6h → 2h** so aged terminal failures stop dominating fingerprints after recovery.

## 4. Entitlement hook (`done`)

```text
ENTITLEMENTS_ENFORCED=0   # default — no billing gate on live tools
ENTITLEMENTS_ENFORCED=1   # enforce via assertFirmEntitled(firmId)
```

- Module: `artifacts/api-server/src/lib/entitlements.ts`
- Wired in `requireBullhornFirm` (same live MCP/`/api/v1` gate as lifecycle).
- When enforced: `subscriptionStatus` ∈ `{active, trialing}` → entitled (pilots already set `active` via activate-pilot). Else **402** with clear “not entitled” message.
- **No Stripe keys required.** No `firm_entitlements` table yet — reuse `firms.subscription_status`.
- **Stripe plug-in later:** keep `assertFirmEntitled`; point `resolveFirmEntitlement` at live Stripe / new table; flip env to `1` after checkout + webhooks are trusted.

## 5. Staff-path reliability (`done` — verified 2026-08-05)

**Contract (unchanged soft walls):** [universal-async-jobs.md](./universal-async-jobs.md)

| Sync | MCP start | REST start |
|------|-----------|------------|
| `scout_dept_report` | `start_scout_dept_report_job` | `POST …/scout-qualified-by-department/jobs` |
| `match_candidates_for_job` | `start_match_candidates_job` | `POST …/match-candidates-for-job/jobs` |
| `recruiter_leaderboard` | `start_recruiter_leaderboard_job` | `POST …/recruiter-leaderboard/jobs` |

**Unit / contract:** `report-jobs.test.ts` — `wall_time` → host-complete `asyncContinuation` (MCP + REST) for scout/match/leaderboard; soft walls stay 95s/75s; async safety max ~20 min.

**Live smoke (prod MCP, service/user bearer via `ASKTOACT_MCP_API_KEY`):**

| Path | Evidence |
|------|----------|
| Scout async | `start_scout_dept_report_job` (STSI, limit=2) → `get_report_job` **complete**, `confirmedComplete=true`, `stopReason=complete` (job `3f609702-…`) |
| Match async | `start_match_candidates_job` (job 31887) → `get_report_job` **complete** with match payload (job `4af76790-…`; result `status=partial` is expected sourcing semantics, not job failure) |
| Sync wall_time | Hard to force under snapshot-fast path; contract tests cover `asyncContinuation` shape. Sync scout with limit=2 returns `complete` without continuation (healthy). |

Hitting sync `wall_time` in production is uncommon for scout while note-snapshot coverage is fresh — that is success, not a gap. Escape hatch remains: start_* → poll.

## 6. Light security pass (`done` — notes)

| Surface | Auth | Notes |
|---------|------|-------|
| MCP `/mcp*` | Bearer (service **or** user apiKey) + `requireBullhornFirm` + firm ALS | Timing-safe token compare; lifecycle suspend; optional entitlement when env on |
| REST `/api/v1/*` | Same bearer + firm gate | Read+report subset public OpenAPI is unauthenticated **schema only** |
| Firm admin `/api/firms/*` | Service token (`requireService`) | User keys cannot sync note-snapshot or manage firms |
| Ops `/api/internal/ops-health`, `ops-agent-notify` | `MCP_BEARER_TOKEN` **or** `OPS_HEALTH_SECRET` | Dedicated secret preferred for ops scripts |
| Custom GPT OpenAPI/instructions | Unauthenticated discovery | Operations still bearer-gated |

No broad auth rewrite this tranche. Remaining hardening (later): rotate ops secret separate from MCP, rate-limit ops notify, audit portal session cookies.

## 7. Host UX polish (`done` — docs only)

See [asktoact-mcp-api-key.md](./asktoact-mcp-api-key.md) and [ops-alerts.md](./ops-alerts.md).

- **Cursor Secrets:** `ASKTOACT_MCP_API_KEY` = production **service** `MCP_BEARER_TOKEN` for ops + headless reads; portal user apiKey only when writes must attribute to a recruiter.
- **Ops-health auth gotcha:** `/api/internal/ops-health` accepts **only** service bearer or `OPS_HEALTH_SECRET` — a portal user apiKey returns `403 Forbidden: invalid ops credentials` even though the same key works for `/api/mcp` tools.
- **Custom GPT:** shared key = shared audit principal; prefer per-user MCP ([customgpt-actions-surface.md](./customgpt-actions-surface.md)). Soft-wall continuation on Actions = REST paths in `asyncContinuation.rest`.
- **ChatGPT “Always allow” vs reconnect:** [chatgpt-connector-hosting.md](./chatgpt-connector-hosting.md).

No UI rewrite this tranche.

## 8. Broader async coverage (`deferred`)

Reviewed: tools that already soft-wall with `asyncContinuation` are scout, match, recruiter_leaderboard — the ones that regularly need >95s under real staff load.

Sync-only long walks (broad `search_*`, placements fan-out, exhaustive note association without snapshot) *can* soft-wall without a start_* tool, but:

- Scout’s hot path is mostly snapshot-served and finishes under the wall.
- Match/leaderboard already have async.
- No production incident fingerprint points at a *regular* sync-only wall without escape hatch.

**Do not** preemptively async-wrap the inventory. Revisit when ops-health or staff reports show a specific tool repeatedly returning incomplete under `wall_time` without `asyncContinuation`.

## How to verify (staff)

1. Soft-wall escape (preferred smoke — does not need to hit sync wall):
   ```bash
   pnpm --filter @workspace/scripts asktoact-mcp call start_scout_dept_report_job '{"department":"STSI","limit":2}'
   pnpm --filter @workspace/scripts asktoact-mcp call get_report_job '{"jobId":"<uuid>"}'
   # expect status complete
   pnpm --filter @workspace/scripts asktoact-mcp call start_match_candidates_job '{"jobId":31887,"limit":4}'
   # poll get_report_job until complete|failed
   ```
2. `pnpm --filter @workspace/scripts ops-health -- --json` → prefer `ok`. Requires **service** bearer or `OPS_HEALTH_SECRET` (not a portal user key).
3. Note-snapshot: cron `SYNC_OK`; coverage not stuck `failed` from transient 504s.
4. With `ENTITLEMENTS_ENFORCED` unset: tools work as today. Do **not** enable in prod until Stripe path is ready.
5. Contract tests: `pnpm --filter @workspace/api-server exec vitest run src/lib/report-jobs.test.ts src/lib/bullhorn-transient.test.ts`
