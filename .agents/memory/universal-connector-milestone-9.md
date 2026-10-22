---
name: Universal connector peak before Stripe + customer #2
description: Status board for confidence ~8.5–9 without live Stripe or a second Bullhorn customer.
---

# Peak before Stripe + customer #2

**Status:** `achieved pending staff soak`

**Score:** **~8.8–9.0** (win band 8.5–9 met; not a full “9.0 locked” until short staff soak)

**Closed (agent side):** 2026-08-05 — live async smokes (scout + match + recruiter_leaderboard), Railway SUCCESS on HEAD, board win conditions done/deferred with honesty.

**Win condition:** Raise production confidence without:

- Live Stripe billing activation
- Standing up a second Bullhorn customer
- Marketplace / ChatGPT store listing

Soft walls stay unchanged (~95s sync; async continuation is the escape hatch).

**Next leap only:** Stripe live + customer #2. Nothing else gates declaring this peak closed after staff soak.

## Production deploy (confirmed 2026-08-05)

| Field | Value |
|-------|--------|
| Project | `ask-to-act` `b7311b38-ef88-49b1-b28f-98f4fcd3ad0b` |
| Service | `@workspace/api-server` `a9961756-a60b-4f4d-a8cd-ab018c10df4f` |
| Env | `production` `b647a409-377d-4067-8fbf-10d6fb325658` |
| Latest deploy | `82f54581-35aa-4999-ba97-15801b767507` **SUCCESS** |
| Commit | `e1330f6` (`e1330f62512f51cccb6cf183adc9773858f98c22`) — docs tranche 2 |
| Code ancestry | `89af44c` (504 retry, entitlements, ops lookback) **is ancestor** of deployed HEAD — no further api deploy needed |

Note: latest Railway image is docs-only rebuilds on top of tranche-1 code; image digest unchanged across `36e9aa7` → `e1330f6` is expected.

## Checklist — win conditions

| # | Win condition | State | Evidence |
|---|---------------|-------|----------|
| 1 | Tenant-safe sync/cron/jobs/alerts (no cross-tenant hardcoding) | **done** | Firm-scoped runtime; Myticas cron URL intentional single-firm |
| 2 | Note-snapshot Bullhorn 502/503/504 retry on reads | **done** | `bullhorn-transient.ts` + unit tests; in `89af44c` → prod via `e1330f6` |
| 3 | Ops aged-failure thrash reduced (2h lookback) | **done** | Code default; automation no-ops on ops-health `ok` |
| 4 | Entitlement hook stub, enforcement **off** | **done** | `assertFirmEntitled`; `ENTITLEMENTS_ENFORCED` unset in prod → default off |
| 5 | Staff soft-wall escape: start_* → get_report_job complete | **done** | Live scout + match (prior) + leaderboard (2026-08-05) |
| 6 | Light security pass (MCP/REST/ops auth notes) | **done** | Notes only; no auth rewrite |
| 7 | Host UX polish (secrets / ops-health gotcha) | **done** | Docs in this board + asktoact-mcp-api-key / ops-alerts |
| 8 | Broader async wrap of all long tools | **deferred** | No regular sync-only wall incidents; revisit on fingerprint |
| — | Soft walls unchanged | **done** | Contract tests; no wall shortening |
| — | Stripe live | **out of scope** | Next leap |
| — | Customer #2 Bullhorn tenant | **out of scope** | Next leap (incl. multi-firm cron) |
| — | Marketplace listing | **out of scope** | GTM timing |

### Remaining (not blockers for this peak)

| Item | Owner | Notes |
|------|-------|-------|
| Staff soak (days, not weeks) | Kyle / recruiters | Use scout/match/leaderboard async when walls hit; watch ops alerts |
| Ops-health green via **service** bearer | Kyle | Portal user key → 403 (expected); see USER ACTIONS |
| Optional: set Cursor `ASKTOACT_MCP_API_KEY` = service token for headless ops | Kyle | Keeps MCP tools + ops-health on one secret for agents |
| Do **not** set `ENTITLEMENTS_ENFORCED=1` | Kyle | Until Stripe checkout + webhooks trusted |

## Live smokes (2026-08-05)

| Path | Result |
|------|--------|
| `start_recruiter_leaderboard_job` (2026-07-01→07) → `get_report_job` | Job `56696c2b-…` **complete**, `confirmedComplete=true`, `stopReason=complete` (empty period OK) |
| Scout async | Prior: `3f609702-…` complete |
| Match async | Prior: `4af76790-…` complete (`status=partial` = sourcing semantics) |
| `ops-health --json` with current Cursor secret | **403** — secret is portal user apiKey (64-char), not service bearer (32-char). Documented gotcha, not a prod outage. |

## Explicitly deferred

| Item | Why deferred |
|------|----------------|
| Stripe live billing | Product/ops decision; keys + webhook + real checkout |
| Customer #2 Bullhorn tenant | Needs corp token + discovery + cron expansion |
| Marketplace listing | GTM timing; not a reliability unlock |
| Broader soft-wall → async wrap | No sync-only tool regularly hits walls in staff use (see §8) |

## USER ACTIONS (Kyle)

### Already live — no deploy needed

- Tranche 1 API on production: 504/502/503 read retries, `assertFirmEntitled` (off), ops failed-job lookback 2h.
- Async escape hatches: scout, match, recruiter_leaderboard (`start_*` → `get_report_job`).
- Docs / status board on main (`e1330f6`).
- Note-snapshot cron still Myticas-only (intentional until customer #2).

### You should still do (short list)

1. **Staff soak (1–3 days):** Have recruiters run normal ChatGPT/Cursor flows; if a soft wall appears, confirm the host continues via `asyncContinuation` (or ask them to call the matching `start_*` tool). No need to force sync `wall_time`.
2. **Ops-health with service credentials:**  
   `pnpm --filter @workspace/scripts ops-health -- --json`  
   using production **`MCP_BEARER_TOKEN`** or **`OPS_HEALTH_SECRET`** (not a portal user apiKey). Prefer `status: ok`.
3. **Leave entitlements off:** Do not set `ENTITLEMENTS_ENFORCED=1` until Stripe is live and trusted.
4. **Optional secret hygiene:** For cloud agents that need ops + MCP, set Cursor Runtime Secret `ASKTOACT_MCP_API_KEY` to the **service** bearer; use portal user keys only when writes must attribute to a recruiter.

### Not your job for this milestone

- Redeploy api-server (already SUCCESS on `e1330f6`).
- Enable Stripe, add customer #2, or list on the marketplace.
- Expand note-snapshot cron to multi-firm (belongs with customer #2).

## Prioritized backlog (archive)

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Tenant-safe audit (no Myticas hardcoding in sync/cron/jobs/alerts) | `done` | Code paths firm-scoped; cron URL intentionally single-firm (see below) |
| 2 | Note-snapshot Bullhorn 504 retry/backoff | `done` | Bounded retries on 502/503/504; unit coverage in `bullhorn-transient.test.ts` |
| 3 | Ops aged-failure / thrash reduction | `done` | Failed-job alert lookback 6h → 2h; automation already no-ops on `ok` |
| 4 | Entitlement/subscription hook stubs | `done` | `assertFirmEntitled` + `ENTITLEMENTS_ENFORCED=0` default; plugs into Stripe later |
| 5 | Staff-path reliability (async tools vs walls) | `done` | Live start→poll complete for scout + match + leaderboard; contract tests for wall_time→asyncContinuation |
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

**Live smoke (prod MCP):**

| Path | Evidence |
|------|----------|
| Scout async | `start_scout_dept_report_job` (STSI, limit=2) → `get_report_job` **complete**, `confirmedComplete=true`, `stopReason=complete` (job `3f609702-…`) |
| Match async | `start_match_candidates_job` (job 31887) → `get_report_job` **complete** with match payload (job `4af76790-…`; result `status=partial` is expected sourcing semantics, not job failure) |
| Leaderboard async | `start_recruiter_leaderboard_job` (2026-07-01→07) → `get_report_job` **complete** (job `56696c2b-…`) |
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
   pnpm --filter @workspace/scripts asktoact-mcp call start_recruiter_leaderboard_job '{"startDate":"2026-07-01","endDate":"2026-07-07"}'
   ```
2. `pnpm --filter @workspace/scripts ops-health -- --json` → prefer `ok`. Requires **service** bearer or `OPS_HEALTH_SECRET` (not a portal user key).
3. Note-snapshot: cron `SYNC_OK`; coverage not stuck `failed` from transient 504s.
4. With `ENTITLEMENTS_ENFORCED` unset: tools work as today. Do **not** enable in prod until Stripe path is ready.
5. Contract tests: `pnpm --filter @workspace/api-server exec vitest run src/lib/report-jobs.test.ts src/lib/bullhorn-transient.test.ts`

## After this milestone

**Only:** Stripe live billing + customer #2 (corp token, discovery, multi-firm note-snapshot cron). Marketplace remains GTM-timed and separate.
