---
name: Bullhorn consent-bounce recovery
description: Why enrollment bounce recovery must be a client return-visit heuristic, not server-side detection
---

Bullhorn's FIRST-TIME OAuth consent screen often bounces a brand-new user
back to Bullhorn's own login page instead of returning to our callback, so
enrollment silently never completes (refreshToken stays null). Observed as the
majority path for new recruiters (Agree → login loop).

**Product response (current):** Do NOT auto-redirect to Bullhorn on first enroll
visit. Show a **choice page** with **Connect manually (recommended)** as the
primary CTA and **Continue with Bullhorn sign-in** (`?go=1`) as secondary.
Manual uses headless OAuth on the server and avoids the consent bounce entirely.

**Bounce recovery still exists:** If the user does choose browser OAuth (`?go=1`),
plant a short-lived cookie; on a later GET enroll (still unconnected) with a
matching cookie, show the recovery page (manual first, OAuth retry second).

**Our-side HTTP 500s (mitigated):** Authorize-URL build and callback/code-exchange
failures used to surface as catch-all **500**. They now return **502** with a
short scrubbed reason (full error in server logs). If browser OAuth fails at
authorize-build (`?go=1`) or at callback code exchange, we recover to the
**manual enroll form** (`?manual=1&oauth_failed=1`) while the one-time token is
still valid — do not treat that as a successful connect.

**OAuth state durability:** Pending `state` values live in Postgres
(`oauth_states`), not an in-memory Map, so authorize and callback can land on
different Railway instances. Browser authorize uses the firm's stored
`oauthUrl` when known (same as callback exchange) to avoid swimlane mismatch.

**Still Bullhorn-only:** Consent bounce / Agree → login loop cannot be fixed on
our side; manual enroll remains the reliable path. Soft walls unchanged.

**Rule:** Recovery cannot be detected server-side when the user is stranded on
Bullhorn's domain — they never hit our callback. Detect the *return visit*
instead via the cookie heuristic.

**Why:** Any "detect the bounce" approach is impossible by construction; the
only observable event we control is the user re-opening the enrollment link
(or choosing manual on the choice page).

**How to apply:** The cookie must be sameSite=lax (survives the top-level
return navigation) and the recovery/manual paths must stay token-gated so
crawlers never reach the Bullhorn password form (the pattern that previously got
the domain flagged "deceptive site"). Support: if someone is stuck on Bullhorn
login after Agree, or sees a 502 after automatic sign-in, tell them to re-open
the enrollment link and use **Connect manually**.
