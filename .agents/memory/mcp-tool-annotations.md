---
name: MCP tool annotations (read-only servers)
description: A read-only MCP server must declare tool annotations or ChatGPT classifies every tool as destructive and OpenAI safety-blocks the calls.
---

# Read-only MCP servers MUST declare tool annotations

**Rule:** every tool on a read-only MCP server must advertise annotations
`{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }`.

**Why:** if you register tools with NO annotations, MCP defaults apply
(`readOnlyHint=false`, `destructiveHint=true`, `openWorldHint=true`). ChatGPT then
tags every tool **WRITE · DESTRUCTIVE · OPEN WORLD**, and OpenAI's safety layer
**blocks** the calls with *"This tool call was blocked by OpenAI's safety checks"*
and forces a per-call approval prompt on every single call. Observed live: résumé
reads tagged destructive were blocked even though the server returned 200s in
<1s — so the symptom looked like "slow / connector keeps asking / blocked" but the
root cause was the missing annotations, not the server.

**How to apply:** register tools through a small wrapper that injects the
annotations, so a future `server.tool(...)` can't silently bypass it. Verify with a
`tools/list` call over the live endpoint and assert every tool has
`readOnlyHint:true`. `openWorldHint:false` is correct for a bounded single-tenant
data source (e.g. one company's ATS) — it is NOT an open web/search tool.

**Residual (important):** annotations fix only the *misclassification*. They do NOT
disable OpenAI's privacy/safety layer — bulk personal data, full résumés, or
sensitive phrasings (e.g. clearance + government terms) can still be withheld
client-side ("the connector blocked that phrasing" is ChatGPT's own layer, not the
server). Mitigate by keeping responses small: prefer VERIFY/highlight excerpt mode
and short shortlists over dumping full PII.
