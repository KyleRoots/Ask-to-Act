---
name: ChatGPT/MCP tool-output size ceiling
description: Why broad Bullhorn reads get "blocked by the connector safety layer" in ChatGPT, and how to keep responses under the client's tool-output size cap. Read before changing default field sets, response serialization, or adding new list/search/query tools.
---

# Symptom
ChatGPT says something like "some list/query calls are being blocked by the connector
safety layer, so I'm switching to the search endpoints and validating each object
separately." NOTE: "blocked by the safety layer" is ChatGPT's catch-all phrasing and
has MORE than one cause — it can also mean PII withholding or read/write annotation
classification (see bullhorn-candidate-search.md and mcp-tool-annotations.md). But
when it appears on broad, high-`count`, default-field reads with no PII angle, the
cause is the ChatGPT/OpenAI client-side tool-output SIZE limit: when a tool result is
too large the client silently drops the whole result, and the assistant narrates that
as a "safety layer" block, then falls back to leaner calls. It is NOT our server
refusing the call.

# Trigger
Large multi-record responses. Three factors stack: (1) rich DEFAULT field sets
(nested objects like address/clientCorporation/owner expand a lot), (2) high `count`
(200-500), (3) pretty-printed JSON wasting ~30% on whitespace. Observed pre-fix:
search_jobs c200 ~196KB, search_candidates c100 ~124KB, list_placements c200 ~113KB.
Scoping `fields` cuts this dramatically (placements c200 -> ~19-27KB).

# Mitigations (in priority order)
1. Compact JSON, no pretty-print indentation (done in formatResult) — saves ~26-32%,
   zero data loss.
2. Scope `fields` to only what's needed on multi-record pulls.
3. Paginate via `count`/`start` instead of one giant pull.
4. Keep big free-text out of multi-record defaults (publicDescription, full résumé
   text) — already done; fetch those per-record via get_* tools.

**Why:** the data is fully reachable — this is purely a payload-size ceiling, so the
fix is right-sizing responses, not "unlocking" access. Expanding default fields to
surface custom fields makes broad pulls bigger, which works against this ceiling.

**How to apply:** when adding/altering a multi-record tool or its default fields,
keep typical responses well under ~100KB; if a broad pull would still be huge, prefer
returning explicit guidance to narrow scope over emitting an oversized payload that
the client silently drops.

# SINGLE-record get_* tools can trip the cap too (not just broad pulls)
A per-record `get_*` fetch can ALSO be silently dropped if it carries one big raw
free-text/HTML field — a job's `publicDescription` (raw HTML) alone pushed a single
`get_job` over the cap and surfaced as "the full-description pull was blocked by the
connector safety layer."
**Rule:** any get_* tool returning a large raw free-text/HTML field (publicDescription,
full résumé) must strip HTML (reuse stripHtml) and cap its length at the fetch helper,
so the field can never blow the cap regardless of which AI drives.
**Why:** the trigger isn't only multi-record breadth; one unbounded HTML field is
enough. Capping at the helper covers BOTH direct calls and internal consumers (e.g. the
matcher calls getJob too) in one place.
**Also steer the model:** when a get_* fetch exists only to feed another tool (e.g.
pull a job just to find candidates), point its description at the all-in-one tool
(match_candidates_for_job reads the JD server-side) so the model skips the big fetch.
