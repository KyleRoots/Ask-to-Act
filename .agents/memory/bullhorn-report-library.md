---
name: Bullhorn report library (v1)
description: Pre-built server-computed report tools on the MCP server — their locked metric definitions and the fetch-vs-count techniques each relies on.
---

# Report library (reports.ts) — v1

Six baked-in READ report tools + a `list_reports` catalog, exposed as MCP tools
alongside the ad-hoc tools: staffing_scorecard(year?),
placements_report(startDate?,endDate?,status?), open_jobs_report,
sales_pipeline_report, job_aging_report, recruiter_leaderboard(startDate?,endDate?).
Each runs its Bullhorn queries in parallel (one round-trip for the client) and
returns a compact table + short summary.

## Locked metric definitions (corp 28404, Myticas) — keep identical everywhere
- Open jobs = `isOpen:true AND NOT status:Archive` (the open flag still includes
  on-hold/filled/placed; only Archived is excluded).
- Placements made / confirmed = status Approved OR Completed OR Ended (exclude
  Submitted, Canceled, Archive).
- Active opportunities = NOT Closed-Won / Closed-Lost / Converted.
- Departments (stable): STS-STSI, MYT-Ottawa, MYT-Chicago, MYT-Clover, MYT-Ohio.
  Dept field = correlatedCustomText1 on JobOrder/Placement, customText1 on Opportunity.
- Status spellings are exact/case-sensitive: `Canceled` (one l), `Archive` (not
  "Archived"); a wrong spelling is silently ignored.

## Query techniques each report depends on (non-obvious)
- Placements are small (~123 YTD) → FETCH + aggregate by owner/dept/employmentType.
  `owner.id:N` as a Placement Lucene filter returns 0, so never filter by it — fetch
  and bucket in code.
- Submissions are high-volume (72k YTD) → COUNT only, never fetch. `sendingUser.id:N`
  DOES work as a JobSubmission query filter; the leaderboard counts per recruiter with
  bounded concurrency.
- count_entity `groupBy` cannot take nested/dotted fields (owner.id, sendingUser.name)
  — discovery passes groupBy as a /search `fields` param which rejects dots. Pass the
  known dept names as `groupValues` for exact grouped counts.
- Job-aging buckets are derived from cumulative "added before X days ago" count_entity
  calls, subtracted into disjoint buckets (no overlap).

**Why:** these are the conventions the user signed off on; any new report or ad-hoc
answer must reuse them so numbers stay consistent across the connector.
**How to apply:** when adding reports or answering scorecard-style asks, reuse the
reports.ts helpers and these exact definitions rather than re-deriving filters.

## YTD date ranges
Default current-year reports cap the end at "today" (not next-year Jan 1) so a YTD
figure can never include a future-dated record. Past explicit years span the full
calendar year.
