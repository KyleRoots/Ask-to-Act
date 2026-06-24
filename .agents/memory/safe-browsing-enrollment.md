---
name: Safe Browsing enrollment flag
description: Why connect.asktoact.ai got flagged "deceptive site" and the enrollment redirect design that fixes it.
---

# Hosting a Bullhorn password field on our own domain triggers Google Safe Browsing

**Symptom:** Chrome shows a red "Dangerous/Deceptive site" interstitial on enrollment
links, AND the ChatGPT MCP connector silently stops working (backslash no longer
calls it). Both come from the SAME cause: Google Safe Browsing flagged the domain,
and OpenAI runs the same Safe Browsing check, so it disables connectors on a flagged
host. Deleting/re-adding the connector does NOT help — the flag is on the DOMAIN.

**Root cause:** `GET /api/auth/user/enroll` rendered an HTML form collecting the
user's **Bullhorn username + password on connect.asktoact.ai**. A non-Bullhorn site
asking for Bullhorn credentials is the textbook phishing pattern Safe Browsing's
deceptive-site heuristic catches (worse on a newer domain + one-time `?token=` links).

**Fix (design):** The default enroll URL must **302-redirect to Bullhorn's own
`/authorize` login page** (`getAuthorizeUrl(state)` with a `user:<userId>:<hex>`
state), so no password field is ever served on our domain. The shared
`/api/auth/bullhorn/callback` already routes `user:` states to
`completeUserEnrollment`. The legacy server-side credential form is preserved ONLY
behind `?manual=1` (intentionally unlinked) as an escape hatch, so crawlers never
see a password field on the default URL.

**Why keep a manual fallback at all — the unresolved tension:** Bullhorn's
FIRST-TIME browser consent screen reproducibly **bounces** back to login and never
returns a code (see `bullhorn-oauth.md` history). That bounce is the original reason
the team built the headless password flow. So the redirect flow can stall at
first-time consent for an un-consented user. The robust permanent fix is a Bullhorn
Support request to **auto-approve / mark the OAuth client trusted** (skip the consent
screen) — then the redirect flow works for everyone and `?manual=1` can be retired.

**How to apply:**
- Never render a Bullhorn (or any third-party) password field on our domain in the
  default path. If a credential form must exist, gate it behind an unlinked/guarded route.
- Clearing the current flag is operational, not code: verify the domain in Google
  Search Console → Security Issues → Request Review (only the domain owner can).
- When validating, test with ONE real user before mass enrollment — that's the only
  way to learn whether Bullhorn's per-user consent bounces in production.
