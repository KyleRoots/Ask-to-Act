---
name: Bullhorn metric definition drift (MCP)
description: Why the MCP connector returns inconsistent headline metrics (e.g. open jobs 513 vs 414) and how to enforce locked definitions.
---

# Metric definition drift via the MCP connector

**Observed:** Asking the connector "how many open jobs?" returned **513** (raw `isOpen:true`),
not the locked/correct **414** (`isOpen:true AND NOT status:Archive`). Difference = ~99
archived-but-still-open JobOrders. Confirmed live via REST `/v1/count`: raw=513, curated=414.

**Root cause:** The locked "open jobs = isOpen AND NOT Archive" convention is documented in
the MCP tool descriptions (count_entity, search_jobs) AND enforced in code in the pre-built
report tools (`reports.ts` OPEN_JOBS_QUERY). But for a plain "how many" question the model
called the **generic `count_entity`** and **composed its own loose query** (`isOpen:true`),
ignoring the documented convention. The model freelances.

**Durable lesson:**
- Tool-description conventions are **suggestions the model can and does ignore**. Do NOT rely
  on them for correctness of headline metrics.
- Enforce metric definitions **in code** via dedicated/pre-built report tools (these already
  return the correct numbers: scorecard, open_jobs_report, etc.).
- The danger is **inconsistency**: the same question yields 414 (pre-built report) or 513
  (improvised count) depending on which tool the model picks — corrosive for a trust product.

**Why:** AskToAct's entire value prop is accurate, consistent, permission-aware answers. Metric
drift is the exact failure the product is meant to eliminate.

**How it was hardened ("Full lock"):** A server-side guard (`applyMetricDefinitionGuard` in
bullhorn-client.ts) rewrites freelanced queries and is wired into BOTH `countEntity` AND
`searchEntity` — count-only enforcement is NOT enough because the model also bulk-fetches via
search/list tools and tallies client-side (that road is wrong AND slow — the minute-long
"Thought for 1m12s" the user saw). The guard: JobOrder `isOpen:true` (no explicit `status:`)
→ append `AND NOT status:Archive` (414); Opportunity `isOpen:true` (no `status:`) → append
`NOT status:"Closed-Won" AND NOT status:"Closed-Lost" AND NOT status:Converted` (verified:
isOpen:true 34 → with exclusions = 24, identical to the status-only definition; also stops the
model hand-subtracting to 23). It skips when the query already has `status:` (prevents
double-apply; lets power users override). It also returns `appliedDefinition` so the model is
told NOT to subtract further.

**Also required (speed + steering):** Cap ALL record-fetch MCP tools at `count` max **50**
(was 500/100) and strip every "set count high / retrieve all in one call / aggregate" hint from
tool descriptions — otherwise the model uses the fetch road. zod caps are MCP-layer only; the
pre-built report builders call bullhorn-client directly and are unaffected.

**Verify against curated truth:** open jobs=414, placements YTD=98, active opps=24,
leaderboard 14 recruiters/98.

## Second drift hole: status-ENUMERATION approximation (Opportunity "active")

**Observed:** "How many active opportunities?" returned **5** (should be **24**). The guard
above only fires on `isOpen:true` AND skips when the query contains `status:`. The model never
used `isOpen:true` — it tried `status:Active` (0 hits, a guessed label that doesn't exist),
then enumerated a SUBSET of open statuses `status:Open OR status:Qualifying` (=5), bypassing the
guard and silently dropping Qualified(14)+New(5).

**Durable lesson:** Locking only the `isOpen:true` path is not enough — the model approximates
"active/open/pipeline" by hand-picking a status allowlist, and a wrong/partial allowlist
undercounts. You cannot read intent from an arbitrary status query, so don't try to rewrite it.

**Fix (annotation, not rewrite):** `opportunityActiveAnnotation` (bullhorn-client.ts) mirrors
`placementConfirmedAnnotation`: for ANY Opportunity count whose query is NOT already the
canonical active set, compute the official active total (24) and attach it + a conditional note
("report activeOpportunitiesTotal for active asks; only report this query's total if the user
asked for these specific statuses"). Skips when query already contains all three
Closed-Won/Closed-Lost/Converted exclusions (guard-applied isOpen:true, or the report tool), so
canonical paths pay no extra call and legit single-status drilldowns (status:Qualified→14) still
answer their own number. Single shared `ACTIVE_OPPS_DEFINITION` const feeds both guard + annotation.

**Why annotation > rewrite here:** rewriting a status query would break legitimate single-status
drilldowns; the conditional note lets the model answer the specific question while still seeing
the locked headline. Same trade as the placement-confirmed pattern.

## Third drift hole: SOFT-DELETED records inflate headline metrics (operational-truth decision)

**Observed:** AI returned **23** active opps and (would return) deleted-inclusive job counts. The
gap was real, not freelancing: Bullhorn's Lucene `/search` INCLUDES soft-deleted records by
default, so the locked definitions were silently counting them. Live-verified: active opps
canonical=24 but isDeleted:false=23 (1 soft-deleted, a "New" status opp); open jobs canonical=414
but isDeleted:false=398 (16 soft-deleted).

**USER DECISION (operational truth):** soft-deleted records are NOT real pipeline — EXCLUDE them.
New locked headline numbers: **open jobs = 398, active opps = 23** (placements unchanged).

**CRITICAL per-entity gotcha — `isDeleted` is NOT a safe universal filter:**
- JobOrder: `isDeleted:false`→398, `:true`→16. Works.
- Opportunity: `isDeleted:false`→23, `:true`→1. Works.
- Placement: `isDeleted:false`→**0** AND `isDeleted:true`→**0** — the field is NOT searchable on
  Placement. Adding `isDeleted:false` would ZERO OUT placement counts. Since `:true`=0 too,
  Placement `/search` already excludes soft-deleted, so it needs NO isDeleted filter and must
  never get one.

**How it was hardened:** appended `AND isDeleted:false` to JobOrder + Opportunity locked
definitions ONLY — in `ACTIVE_OPPS_DEFINITION` (bullhorn-client.ts, feeds both guard + annotation),
the JobOrder guard branch, and reports.ts `OPEN_JOBS_QUERY`/`ACTIVE_OPPS_QUERY`/`DEPT_DEFINITIONS`.
Tool descriptions updated incl. an explicit "do NOT add isDeleted:false to Placement" warning.
Verified all paths converge: isOpen:true→398/23, the AI's `isOpen AND isDeleted:false`→23,
status-subset trap still annotates activeOpportunitiesTotal=23, open_jobs_report=398,
sales_pipeline_report=23 (by stage 14/4/4/1).

**Why per-entity, not global:** `/search` includes deleted but `/query` (where) excludes them, and
field searchability varies by entity — so the deleted-exclusion MUST be applied and verified
entity-by-entity, never blanket-applied.
