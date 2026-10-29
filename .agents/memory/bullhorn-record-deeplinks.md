---
name: Bullhorn record deep links (bullhornUrl)
description: How clickable "open in Bullhorn" links work end-to-end and why they sometimes don't render
---

Every linkable Bullhorn record returned by a read tool already carries a `bullhornUrl`
deep link, injected server-side by `enrichWithProfileUrls` (bullhorn-client.ts) in the
search/query/get paths. Link format: `{base}/openwindow?entity={Entity}&id={id}`.

- **Host is the Bullhorn web app, not the REST cluster.** `base` is `BULLHORN_UI_BASE_URL`
  when that variable is set (trailing slashes trimmed), otherwise `https://app.bullhornstaffing.com`.
  That matches Bullhorn's own Share button
  (`https://app.bullhornstaffing.com/openwindow?entity=JobOrder&id=36144`, and the same path
  for Candidate and ClientContact). Links do not read the session `restUrl`.
- **October 2026 incident.** After Bullhorn's security incident, `OpenWindow.cfm` on every
  `cls{N}.bullhornstaffing.com` host returns HTTP 503 ("This page is currently unavailable").
  The previous builder mapped `rest{N}` to `cls{N}` and emitted
  `/BullhornStaffing/OpenWindow.cfm?Entity={Entity}&id={id}`. That derivation is gone.
  Novo `/openwindow` on `app.bullhornstaffing.com` returns HTTP 200 and does not depend on
  the firm's cluster. `BULLHORN_UI_BASE_URL` now means the Bullhorn web app host, not a cls host.
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
