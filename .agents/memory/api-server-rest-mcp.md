---
name: api-server dual door (MCP + REST) & orval codegen
description: api-server serves the same read-only Bullhorn report/count functions over BOTH an MCP endpoint and an additive REST/OpenAPI surface; how they stay in lockstep, plus orval codegen gotchas.
---

# api-server: MCP door + additive REST door

The api-server exposes the SAME read-only Bullhorn functions (the 6-report library +
count_entity) through two front doors, both behind the same bearer auth:
- MCP endpoint (for ChatGPT/Claude MCP connectors)
- REST/OpenAPI v1 surface under `/api/v1/*` (for non-MCP clients: Gemini, Custom GPT
  Actions, a future dashboard).

**Rule:** REST and MCP must call the SAME underlying report/count functions directly — never
duplicate report logic in a route handler.
**Why:** the product promise is "same trusted answer in ANY AI tool," so divergence between
the two doors is a correctness bug, not cosmetic. Add/repair a report once and both doors get
it; duplicating creates drift between what one AI sees vs another.
**How to apply:** new endpoints import and call the existing lib functions; the route only
validates input and shapes the response.

## openapi.yaml is the single source of truth
- `lib/api-spec/openapi.yaml` is hand-authored; orval generates the typed React client +
  zod from it. Do NOT reverse the direction (never generate openapi from zod).
- The generated client `info.title` must stay `"Api"` (codegen depends on it).
- The api-spec codegen script regenerates `lib/api-zod` + `lib/api-client-react`, then builds
  the libs (tsc --build). Run it after any spec edit and commit the generated output.

## orval gotcha (cost real time)
- A string param declared `format: date` makes orval generate `z.date()` / a JS `Date`, which
  mismatches the YYYY-MM-DD *string* the routes actually accept. Use `type: string` with a
  `pattern` (e.g. `^\d{4}-\d{2}-\d{2}$`) instead so the generated validator stays a string.

## REST error mapping
- The shared Bullhorn functions throw plain `Error`s with secret-free, human-readable
  messages (some embed the upstream status like `error (400)`). The v1 wrapper classifies by
  message: bad input / domain errors (unknown or query-only entity, invalid field/groupBy,
  malformed Lucene) -> 400; upstream rate limit -> 429; anything unrecognized -> generic 500.
**How to apply:** route any endpoint that surfaces Bullhorn errors through the same classifier
so the importing AI gets an actionable 4xx instead of an opaque 500.

## Deferred (not in v1)
candidate/job search+get, résumé/attachment reading, notes/submissions, and ALL writes.
Auth-hardening idea: REST clients should prefer/require the `Authorization: Bearer` header;
the shared middleware also accepts `?key=`/`?token=` query (inherited from MCP), which can leak
tokens in URLs — left as-is in v1 to avoid touching the MCP connector.
