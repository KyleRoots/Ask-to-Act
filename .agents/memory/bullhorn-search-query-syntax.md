---
name: Bullhorn Lucene /search query gotchas
description: Non-obvious Bullhorn /search (Lucene) query rules that make valid-looking filters silently return zero, plus how to tell apart the different ChatGPT "blocked" messages. Read before building/rewriting search queries, or when a search returns 0 but data clearly exists.
---

# Pure-negation queries silently return 0
A Bullhorn /search query made ENTIRELY of negations returns 0 matches — there is no
positive document set to subtract from. Example that wrongly yields 0:
`NOT status:"Closed-Won" AND NOT status:"Closed-Lost" AND NOT status:Converted`
(ground truth at the time: 43 opportunities, 24 of them active).

Fix: prepend a positive anchor that matches every record — `id:[1 TO *] AND <negations>`.

CRITICAL (cost me a wrong first attempt): the anchor must be FLAT (AND-joined at the
top level). A *parenthesized* all-negative group is ALSO rejected and still returns 0:
- BAD  (returns 0):  `id:[1 TO *] AND (NOT a AND NOT b)`
- GOOD (returns n):  `id:[1 TO *] AND NOT a AND NOT b`

Enforced centrally in searchEntity() (the chokepoint for every /search tool) via
anchorPureNegationQuery: rewrite only when every top-level clause is negated; skip
queries containing a top-level OR (a flat prepend would change operator precedence).

**Why:** LLM clients naturally build "everything except X" filters as pure negation,
get 0, and wrongly conclude the data is unavailable. The data is fully reachable —
the query shape was the only problem.

# Only the /search (Lucene) path is affected
The /query (SQL-like `where`) path handles `NOT col='X'` fine and needs NO anchor.
Only the indexed /search endpoints have the pure-negation trap.

# Per-entity custom field for "Internal Department" (easy to get wrong)
See bullhorn-custom-fields.md: JobOrder/Placement = correlatedCustomText1,
Opportunity/most = customText1, Candidate = customText3. Reusing the placement field
on an opportunity search returns NULLs (not an error), so a department column can come
back silently blank.

# Counting records: read `total`, don't fetch + count
The /search response includes `total` = the FULL match count even when count<returned
(so count:1 still returns the true total in ~100-180 bytes). To answer "how many" /
build scorecards, run search count:1 and read `total` — never fetch records and count
them (generic search/query cap at 100 records, so you silently undercount, e.g. "51+"
instead of 414). The /query path does NOT return `total`. The count_entity tool encodes
this; per-group counts are one count:1 query per value.

**Combining a base query with a group clause hits the SAME pure-negation trap.** When
counting by group you build `base AND field:"value"`. If the base is all-negative (e.g.
active opportunities), wrapping it as `(NOT a AND NOT b) AND field:"X"` returns 0 for
EVERY group (parenthesized all-negative = 0). Fix: flat-anchor the base
(anchorPureNegationQuery) and flat-append the clause — `id:[1 TO *] AND NOT a AND NOT b
AND field:"X"`. Only parenthesize the base when it has a top-level OR (else precedence
breaks). Verified: jobs by dept summed exactly to total (242/106/48/13/5 = 414).

# /search date ranges: epoch ms is SILENTLY IGNORED — use yyyyMMdd
A Bullhorn /search (Lucene) date range given in epoch MILLISECONDS returns EVERY record
(no error). `dateAdded:[1767225600000 TO *]` → all 2775 placements; the correct
`dateAdded:[20260101 TO *]` (or yyyyMMddHHmmss) → 123 (true YTD). A future yyyyMMdd → 0,
confirming the format works. LLM clients reach for epoch ms because the /query path uses
ms, so "placements this year" silently comes back as the full history.
Fix (central, in searchEntity via normalizeSearchDateRanges): rewrite epoch bounds inside
`<field>:[lo TO hi]` to yyyyMMddHHmmss(UTC) ONLY when the LEAF field name (after the last
dot) is a real date — `/^date/i` or `/^(?:correlated)?customDate\d+$/i`. Detect on the
LEAF, never the whole path: `candidate.id` contains "date" (candi-DATE) and must NOT be
rewritten. Bounds of `*` or 8/14 digits (already Bullhorn format) and non-date numeric
ranges (`id:[1 TO *]`, `salary:[...]`) are left untouched.
NOTE: /query (where) uses epoch ms and works fine — the trap is /search only.

# Status values are exact-match + silent; describe_entity does NOT list them
Wrong status spelling silently no-ops (no error, filter ignored): `NOT status:Cancelled`
(two L) → 414 unchanged; `NOT status:Canceled` (one L, the real value) → 412. The data
uses `Canceled` and `Archive` (not "Cancelled"/"Archived"). describe_entity returns NO
picklist for status (just type:String) — the only way to get valid values is
`count_entity groupBy:"status"` (auto-discovers from a sample). Real JobOrder statuses
seen: Accepting Candidates, Archive, Hold - Client Hold, Hold - Covered, Canceled, Filled,
Placed, Lost - Competition, Placeholder/ MPC, Qualifying, Offer Out, Declined.

# "Open jobs" (isOpen:true) is a BROAD flag, not "actively recruiting"
isOpen:true = 513 and INCLUDES Archive(99), Hold(~99), Canceled(2), Filled(3), Placed(1),
Declined(1), Lost(1). `isOpen AND NOT status:Archive` = 414 still includes Hold/Filled/
Placed/Canceled. "Actively recruiting" (Accepting Candidates) alone = 287. So a "open
jobs" scorecard number depends on a business definition — confirm with the user.

# Three DIFFERENT ChatGPT "blocked" messages — do not conflate
1. "blocked by the connector safety layer" (assistant narration) = client-side
   tool-output SIZE drop. Fix: compact JSON + scoped fields + pagination. See
   response-size-limits.md.
2. Tool tagged DESTRUCTIVE / approval nag = missing read-only annotations. Fix:
   readOnly/destructive/openWorld hints. See mcp-tool-annotations.md.
3. "This tool call was blocked by OpenAI's safety checks. Please double check what
   you are sending." = OpenAI's OUTBOUND moderation on the model's tool call, BEFORE
   it reaches our server (so server-side code can't directly override it). Observed
   correlating with long model retry loops (here ~3m42s, calls 27-31). Best levers we
   control: deploy current code so responses are small + correctly annotated, and make
   first-try calls succeed so the model stops looping.
