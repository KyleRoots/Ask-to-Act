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

## Fourth drift hole: per-group breakdowns + phrasing bypass the headline lock

**Three failure modes found in QA, all "the lock applied to only SOME query shapes":**

1. **Alternate phrasing** — "still open opps" expressed as the 3 closed-status exclusions WITHOUT
   `isOpen:true` skipped the soft-delete exclusion (lock was gated on isOpen-intent), so it
   returned the deleted-inclusive count and a per-status breakdown summed to one over the locked
   total (a soft-deleted "New" opp). **Fix:** make the soft-delete exclusion UNIVERSAL per entity
   — JobOrder & Opportunity append `isDeleted:false` to EVERY query (unless caller pins isDeleted);
   the metric-SPECIFIC parts (NOT Archive for jobs, the 3 closed-status exclusions for opps) stay
   gated on isOpen-intent-without-status.

2. **Breakdown can't reconcile** — "placements by employment type" with no status returned the
   all-status total and a breakdown summing above the confirmed headline, because confirmed-status
   was only an ANNOTATION, not enforced on the base. **Fix/decision:** Placement now DEFAULTS to the
   confirmed-status definition in the guard when the caller pins no `status:` (so total AND every
   group reconcile to YTD/all-time confirmed). An explicit `status:` overrides. This is a semantic
   change to the raw number but it ENFORCES the already-locked "placements made = confirmed" def.

3. **Top-level OR precedence (Lucene)** — `AND` binds tighter than `OR`, so appending a lock as
   `base AND isDeleted:false` onto a base like `status:New OR status:Qualified` parses as
   `status:New OR (status:Qualified AND isDeleted:false)` — the lock hits only the LAST OR branch
   and the others leak (Bullhorn even returned a nonsensical partial count). **Fix:** an
   `andLockClause(base, addition)` helper PARENTHESIZES the base whenever it contains a top-level
   `OR` before AND-appending. Used at every guard append site. The grouped-breakdown path already
   did this (`hasTopLevelOr` → `(base) AND clause`); the guard itself did not.

**Durable rule:** any server-side metric lock must be (a) applied to EVERY query shape for the
entity, not just the canonical one, and (b) AND-appended with the base parenthesized if it has a
top-level OR. A lock that fires on only one phrasing is worse than no lock — it makes drift
look authoritative. **Why:** the product's value is that the headline AND its breakdown always
reconcile to the same locked universe regardless of how the AI phrases the query.

**Honor explicit power-user isDeleted:** when the caller pins `isDeleted:true`, do NOT also append
`isDeleted:false` (contradiction → 0). The isOpen-opps branch appends only the status exclusions
in that case (matches JobOrder), and its `appliedDefinition` text must NOT claim isDeleted:false.

## Speed: parallelize independent reads, never sequential per-group counts

**Decision:** Counting/breakdowns must go through `count_entity` (server-side, locked), NOT the
fetch-records-and-tally road (slow + hits the 50-record cap). To keep `count_entity` fast: the
per-group breakdown fans out with BOUNDED concurrency (`mapWithLimit`, limit 5) instead of a
sequential `for...await`, and the headline total + the two entity-gated annotations
(placement-confirmed, opportunity-active) run in one `Promise.all`. An 8-group cold breakdown
dropped from ~8 serial round-trips to ~1.2s.

**Why limit 5, not unbounded:** Bullhorn REST is 120 req / 60s. A 50-group breakdown at limit 5
runs in ~10 waves — far under a dangerous burst — while concurrent user traffic still shares that
budget. Unbounded fan-out on a wide groupBy could 429 the whole request.

**Invariant when parallelizing:** locked numbers must not move. `mapWithLimit` preserves input
order (write results by index, sort after), and per-group failures stay isolated
(`{count:null,error}` per group, never fail the batch). Independent-read parallelization is the
only safe speed lever here — never collapse or approximate a count to save a round-trip.

**Steering note on search/list paths:** `searchEntity` now also returns `appliedDefinition` (it
used to discard the guard note). Surfacing the locked definition on the browse path tells the AI
WHY the universe is what it is so it reports the locked number instead of re-tallying records.
Safe for internal callers (`searchTotal` reads only `.total`; group-discovery reads only `.data`).

## Fifth drift hole: the /query SQL-where path (query_entity) bypassed the lock entirely

**Observed:** count_entity/search were locked, but the raw `query_entity` MCP tool — which speaks
Bullhorn's SQL-like `/query` where-syntax (`isOpen=true`, `status<>'X'`, `isDeleted=false`), NOT
Lucene — had NO guard, so an AI browsing/self-counting its rows drifted (24 vs 23, 19 vs 18).
`/query` returns soft-deleted/archived/non-confirmed rows by default just like `/search`.

**Durable rule — enforce the locked universe on EVERY query SHAPE, in BOTH dialects.** The lock
must exist twice: in Lucene (for /search & /count) and in SQL-where (for /query). The syntaxes
differ (`status:X` vs `status='X'`; `NOT status:X` vs `status<>'X'`; `isOpen:true` vs
`isOpen=true`), so derive BOTH renderings from ONE shared status-array source of truth — never
hand-maintain two parallel lists (they will drift).

**Place the guard at the RAW-TOOL boundary, NOT the shared low-level fetch.** The SQL-where guard
belongs on the function backing the raw query_entity tool — never the low-level query helper that
curated list/report functions also call. Those curated functions (e.g. the broad placements list)
apply their OWN deliberate locking/annotation; guarding the shared helper silently overrides them
and makes their notes self-contradictory. Guard the AI-authored door only.
**Why:** the hole is AI-freelanced queries; curated tools are already correct by construction.

**CRITICAL — field-detection regexes must match the ENTITY'S OWN field, never a dotted association
field.** Deciding "did the caller already specify status / isDeleted?" gates whether the default
lock is applied. A bare `\bstatus` / `\bisDeleted` ALSO matches right after a dot, so
`isOpen=true AND clientCorporation.status='Active'` masquerades as an explicit status and SKIPS
the lock (leaks all-status), and `candidate.isDeleted=...` suppresses the soft-delete guard.
Prefix every such detector with `(?<![\w.])` so only the entity's own top-level field counts; the
Placement isDeleted-strip must likewise leave valid association fields (candidate.isDeleted) alone.

**SQL-where per-entity gotchas (differ from Lucene):** `/query` accepts `isOpen=true` (NOT
`isOpen=1` — numeric 400s), `status<>'X'`, `status IN (...)`, and `isDeleted=false` on JobOrder &
Opportunity ONLY. `isDeleted` is NOT a valid field on Placement (errors as both a field and in
where) — strip an AND-joined one, but REFUSE (throw) an OR-joined one rather than silently broaden
the result (`status='Approved' OR isDeleted=false` → all statuses).
