---
name: ChatGPT record hyperlink rendering
description: Why Bullhorn deep links (bullhornUrl) fail to appear in ChatGPT even when present in the tool payload, and the lever that fixes it.
---

# bullhornUrl present in payload ≠ link rendered

The server enriches linkable records with a `bullhornUrl` (Candidate/Job/Company/
Contact/Placement/Submission). Verifying the field is in the response does NOT mean
ChatGPT will show a clickable link. When ChatGPT formats results as a **table**, it
routinely renders the name/ID as plain text and silently drops the link.

A soft instruction ("render the name as that link") is not enough — the model ignores
it under table layout.

**Why:** ChatGPT's table rendering supports markdown links but the model won't add them
unless the tool description is explicit and table-aware.

**How to apply:** each record-returning tool description must carry a forceful directive,
e.g. `DISPLAY RULE (REQUIRED): render the NAME as a markdown hyperlink to its bullhornUrl
in prose, lists, AND tables; never show the name as plain text when a bullhornUrl is
present`. Apply consistently across all linkable-entity tools, not just the one a user
complained about — otherwise the same complaint resurfaces on the next entity.

Precondition to even have a link: the entity is in `UI_LINKABLE_ENTITIES` and the record
has a positive numeric `id`. The URL is always
`{base}/openwindow?entity={Entity}&id={id}`, where `base` is `BULLHORN_UI_BASE_URL`
(trailing slashes trimmed) or `https://app.bullhornstaffing.com`. It does not depend on
the REST swimlane. The old `cls{N}` `OpenWindow.cfm` links started returning HTTP 503
after Bullhorn's October 2026 incident and are not used.
