---
name: Bullhorn MCP record-fetch cap (silent trim, not reject)
description: How the per-call 50-record cap is enforced and why it must live only at the MCP schema layer, never in the shared client functions.
---

# Record-fetch cap = silent trim, enforced ONLY at the MCP layer

Browse/list MCP tools cap returned records at 50 per call. Over-sized requests are
**silently trimmed to 50, never rejected** (a hard zod `.max(50)` reject caused the
AI's first tool call to fail and burn a recovery round-trip — bad for weaker
"bring-your-own-AI" models).

How it's implemented (in `artifacts/api-server/src/lib/mcp-server.ts`):
- Each tool's `count` zod schema uses `.optional().transform(capFetch)` (no `.max`),
  so the parsed count is clamped to `FETCH_CAP` (50) before the handler runs.
- `runTool` post-processes results through `annotateIfTruncated`, which appends a
  `_truncatedNote` ONLY when the result has a `data` array of exactly 50 rows AND an
  explicit Bullhorn `total > 50`. Keying on the `data` array (not a scalar `count`)
  and requiring `total > 50` avoids false notes on count-only / single-entity /
  attachment-list results.

**Why the clamp must NOT go into `bullhorn-client.ts`:** `searchEntity`/`queryEntity`
are also called INTERNALLY with large counts that must not be trimmed:
- `countEntity` group-discovery samples via `searchEntity(..., GROUP_DISCOVERY_SAMPLE=500)`
  to discover distinct groupBy values — clamping it breaks every by-dept / by-type
  breakdown (they'd stop summing to the headline, e.g. open jobs 414).
- `reports.ts` pages placements via `listPlacements(..., count: 500)`.
These internal callers bypass the MCP zod schema entirely, so the schema-layer clamp
leaves them untouched. **How to apply:** if you ever need to change the cap, change it
at the MCP schema/`runTool` layer only — never clamp inside the shared client fetchers.
