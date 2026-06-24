---
name: helmet CSP merges defaults (script-src-attr trap)
description: helmet keeps its strict default directives alongside your custom CSP unless you opt out; the silent one that breaks pages is script-src-attr 'none'.
---

# helmet CSP keeps defaults — `script-src-attr 'none'` silently blocks inline handlers

When you pass `helmet({ contentSecurityPolicy: { directives: {...} } })`, helmet
**merges** your directives with its strict defaults (`useDefaults` is true). The
default set includes `script-src-attr 'none'`, which is a *separate* directive
from `script-src`. So even if you set `script-src 'self' 'unsafe-inline'`, inline
**event-handler attributes** (`onclick`, `onsubmit`, `onload`, …) are still
blocked — `'unsafe-inline'` on `script-src` only covers `<script>` blocks, not
attribute handlers.

**Why:** server-rendered pages that use `onclick="..."` / `onsubmit="..."` (e.g.
copy-to-clipboard buttons, tab switchers, help forms) break under the default
with no error in the response itself — it surfaces only as a browser console CSP
violation. Easy to miss when you verify with curl headers instead of a real
browser.

**How to apply:** if a page relies on inline attribute handlers, explicitly add
`scriptSrcAttr: ["'unsafe-inline'"]` (acceptable when all dynamic content is
already HTML-escaped) — or, better long-term, refactor handlers to
`addEventListener` inside a nonce'd `<script>` and drop `'unsafe-inline'`
entirely. Always confirm the emitted `Content-Security-Policy` header lists
every `*-src*` directive your page actually needs; check the merged result, not
just the directives you wrote.
