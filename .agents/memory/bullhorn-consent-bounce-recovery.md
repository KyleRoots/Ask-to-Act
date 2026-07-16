---
name: Bullhorn consent-bounce recovery
description: Why enrollment bounce recovery must be a client return-visit heuristic, not server-side detection
---

Bullhorn's FIRST-TIME OAuth consent screen often bounces a brand-new user
back to Bullhorn's own login page instead of returning to our callback, so
enrollment silently never completes (refreshToken stays null). Observed as the
majority path for new recruiters (Agree → login loop).

**Product response (current):** Do NOT auto-redirect to Bullhorn on first enroll
visit. Show a **choice page** with **Connect manually** as the primary CTA and
**Continue with Bullhorn sign-in** (`?go=1`) as secondary. Manual uses headless
OAuth on the server and avoids the consent bounce entirely.

**Bounce recovery still exists:** If the user does choose browser OAuth (`?go=1`),
plant a short-lived cookie; on a later GET enroll (still unconnected) with a
matching cookie, show the recovery page (manual first, OAuth retry second).

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
login after Agree, tell them to re-open the enrollment link and use Connect
manually.
