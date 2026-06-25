---
name: Bullhorn linkable id injection
description: Why AI-driven reads sometimes produced records with no clickable Bullhorn URL, and the fix.
---

# Bullhorn linkable id injection

`enrichWithProfileUrls` builds a record's `bullhornUrl` from its numeric `id`.
When the AI supplies a custom `fields` selection that omits `id`, the response
came back with **no `bullhornUrl`**, so the model rendered plain text instead of
a hyperlink — inconsistently across queries.

**Fix:** inject `id` into the field selection (after `sanitizeFields`, in
search/query/get paths) when it's missing.

**Why the scan must be parens-aware:** field lists contain nested association
selections like `owner(id,name)`. A naive substring check for `id` would think
the record already selects a top-level `id` (false positive) and skip injection.
The check only looks at **top-level** comma-separated tokens (depth 0), is
case-insensitive, and skips entirely when `fields` is `*` (everything already
included).

**How to apply:** any new read path that accepts an AI-supplied `fields` arg and
relies on URL enrichment must run the same injection, or hyperlinks will silently
drop for custom-field queries.
