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

**How to apply (hardening, when requested):** Steer the connector so headline asks (open jobs,
placements, pipeline, aging, leaderboard) ALWAYS route to the pre-built report tools, not raw
`count_entity`. Options: strengthen tool descriptions to forbid raw counts for these metrics,
de-emphasize/guard generic count for JobOrder "open" semantics, or add dedicated count tools
that hardcode the locked query. Verify against curated truth: open=414, placements YTD=98,
active opps~24, leaderboard 14 recruiters/98.
