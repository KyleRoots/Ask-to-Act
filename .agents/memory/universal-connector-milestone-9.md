---
name: Universal connector peak before Stripe + customer #2
description: Status board for confidence ~8.5–9 without live Stripe or a second Bullhorn customer.
---

# Peak before Stripe + customer #2

**Score:** ~7 → target **~8.5–9** (this tranche aims ~8.3–8.6)

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

## Prioritized backlog

| # | Item | Status | Notes |
|---|------|--------|-------|
| 1 | Tenant-safe audit (no Myticas hardcoding in sync/cron/jobs/alerts) | `done` | Code paths firm-scoped; cron URL intentionally single-firm (see below) |
| 2 | Note-snapshot Bullhorn 504 retry/backoff | `done` | Bounded retries on 502/503/504 in `bullhornFetch` + search |
| 3 | Ops aged-failure / thrash reduction | `done` | Failed-job alert lookback 6h → 2h; automation already no-ops on `ok` |
| 4 | Entitlement/subscription hook stubs | `done` | `assertFirmEntitled` + `ENTITLEMENTS_ENFORCED=0` default; plugs into Stripe later |
| 5 | Staff-path reliability (async tools vs walls) | `next` | Documented gaps; no soft-wall change this tranche |
| 6 | Light security pass (MCP/REST/ops auth) | `done` | Notes below; no auth rewrite |
| 7 | Host UX polish (Custom GPT / secrets) | `next` | Docs-only gaps |

## 1. Tenant-safe audit (`done`)

**Findings (2026-08-04):**

- Runtime sync/jobs/alerts resolve firms from DB (`firmId` context, active-firm queries). No hardcoded firm IDs in api-server TypeScript for note-snapshot sync, report_jobs, or ops-health.
- Myticas names appear as **documented fallbacks** (`MYTICAS_DEPT_FIELDS`, `DEPARTMENTS` in reports/scout) for firms without `firm_config` — intentional per [firm-config-resolver.md](./firm-config-resolver.md). Not a cross-tenant leak.
- STSI/MYT-* strings in tool descriptions and tests are **examples**, not filters.

**Intentional single-firm cron (not a code leak):**

Railway service `note-snapshot-cron` startCommand POSTs:

`https://connect.asktoact.ai/api/firms/e44c50e3e95e698c/note-snapshot/sync`

(Myticas firm id). Documented in [scout-note-snapshot-design.md](./scout-note-snapshot-design.md). Expanding to customer #2 = add cron(s) or a multi-firm walker — **deferred** with customer #2.

## 2. Snapshot 504 resilience (`done`)

Note-snapshot harvest walks `getNotes` → `bullhornFetch` association pages. Previously only 401/429 were retried; Bullhorn/gateway **504** failed the department sync.

**Fix:** bounded retries with exponential backoff for HTTP **502/503/504** on read paths (`bullhornFetch` + Lucene `search`). Writes are **not** retried on 5xx (non-idempotent). Helpers: `bullhorn-transient.ts`.

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

## 5. Staff-path reliability (`next`)

**Already on soft-wall → async contract** ([universal-async-jobs.md](./universal-async-jobs.md)):

| Sync | MCP start | REST start |
|------|-----------|------------|
| `scout_dept_report` | `start_scout_dept_report_job` | `POST …/scout-qualified-by-department/jobs` |
| `match_candidates_for_job` | `start_match_candidates_job` | `POST …/match-candidates-for-job/jobs` |
| `recruiter_leaderboard` | `start_recruiter_leaderboard_job` | `POST …/recruiter-leaderboard/jobs` |

**Gaps (do not raise soft walls):**

- Other long paged tools (broad search, placements fan-out) still sync-only — may soft-wall without `asyncContinuation`.
- Custom GPT hosts must use REST asyncContinuation; MCP-only start tools are invisible there (already dual-host for the three above).
- Staff validation: run one scout + one match that hit `wall_time`, confirm start→poll completes under a user API key.

## 6. Light security pass (`done` — notes)

| Surface | Auth | Notes |
|---------|------|-------|
| MCP `/mcp*` | Bearer (service **or** user apiKey) + `requireBullhornFirm` + firm ALS | Timing-safe token compare; lifecycle suspend; optional entitlement when env on |
| REST `/api/v1/*` | Same bearer + firm gate | Read+report subset public OpenAPI is unauthenticated **schema only** |
| Firm admin `/api/firms/*` | Service token (`requireService`) | User keys cannot sync note-snapshot or manage firms |
| Ops `/api/internal/ops-health`, `ops-agent-notify` | `MCP_BEARER_TOKEN` **or** `OPS_HEALTH_SECRET` | Dedicated secret preferred for ops scripts |
| Custom GPT OpenAPI/instructions | Unauthenticated discovery | Operations still bearer-gated |

No broad auth rewrite this tranche. Remaining hardening (later): rotate ops secret separate from MCP, rate-limit ops notify, audit portal session cookies.

## 7. Host UX polish (`next` — docs only)

- Custom GPT: shared key = shared audit principal; prefer per-user MCP ([customgpt-actions-surface.md](./customgpt-actions-surface.md)).
- Cursor Secrets: `ASKTOACT_MCP_API_KEY` (+ optional `ASKTOACT_MCP_BASE_URL`) per [AGENTS.md](../../AGENTS.md) / [asktoact-mcp-api-key.md](./asktoact-mcp-api-key.md).
- ChatGPT “Always allow” vs reconnect loops: [chatgpt-connector-hosting.md](./chatgpt-connector-hosting.md).

## How to verify (staff)

1. `pnpm --filter @workspace/scripts ops-health -- --json` → prefer `ok` / no thrash on aged failures.
2. Note-snapshot: after deploy, confirm cron `SYNC_OK` and coverage rows not stuck `failed` from transient 504s.
3. With `ENTITLEMENTS_ENFORCED` unset: tools work as today. Do **not** enable in prod until Stripe path is ready.
4. Soft-wall: scout/match that returns `wall_time` + `asyncContinuation` → start job → poll `complete`.
