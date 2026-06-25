---
name: Bullhorn record deep links (bullhornUrl)
description: How clickable "open in Bullhorn" links work end-to-end and why they sometimes don't render
---

Every linkable Bullhorn record returned by a read tool already carries a `bullhornUrl`
deep link, injected server-side by `enrichWithProfileUrls` (bullhorn-client.ts) in the
search/query/get paths. Link format: `{atsBase}/BullhornStaffing/OpenWindow.cfm?Entity={Entity}&id={id}`.

- **Per-tenant UI base is derived, not hardcoded.** The session's restUrl host `rest{N}.bullhornstaffing.com`
  maps to UI host `cls{N}.bullhornstaffing.com` (verified via loginInfo: rest45 ↔ cls45,
  atsUrl `https://cls45.bullhornstaffing.com`, novoUrl `https://app.bullhornstaffing.com`).
  We use the classic `OpenWindow.cfm` deep link on the cls host — battle-tested, redirects into Novo.
- **Only a whitelist gets links** (`UI_LINKABLE_ENTITIES`): Candidate, ClientContact,
  ClientCorporation, JobOrder, JobSubmission, Lead, Opportunity, Placement. Others get no
  link (never invent one).

**Why links sometimes "don't show":** data presence ≠ rendered links. The `bullhornUrl`
is in the JSON, but ChatGPT only hyperlinks it if told to.

**What actually works (ordered by reliability, from real testing):**
1. MCP server `instructions` (2nd arg to `new McpServer(info, { instructions })`, surfaced at
   `initialize`) — necessary but **NOT sufficient on its own**. With instructions alone,
   ChatGPT auto-linked the EMAIL column (GFM auto-linkifies bare emails) and skipped the
   record deep link entirely.
2. **Per-tool descriptions** — the reliable channel. Append a presentation suffix to every
   read tool's description via the shared `tool()` wrapper (`READ_PRESENTATION_SUFFIX`), so it
   travels with `tools/list` on every chat. Tell it to link ONLY the record name/ID, never
   email/phone (ChatGPT will still mailto-autolink bare emails regardless — that's GFM, not us).
Use both together.

**How to apply:** if a user reports missing/clickable-record issues, first curl prod
`tools/call` and confirm `bullhornUrl` is in the payload (it almost certainly is) — the fix
is presentation guidance (server instructions), not the data path.
