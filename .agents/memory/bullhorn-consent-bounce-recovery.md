---
name: Bullhorn consent-bounce recovery
description: Why enrollment bounce recovery must be a client return-visit heuristic, not server-side detection
---

Bullhorn's FIRST-TIME OAuth consent screen sometimes bounces a brand-new user
back to Bullhorn's own login page instead of returning to our callback, so
enrollment silently never completes (refreshToken stays null).

**Rule:** Recovery cannot be detected server-side — the user is stranded on
Bullhorn's domain, never hits our callback, so we get no signal there. Detect
the *return visit* instead: plant a short-lived cookie when redirecting to
Bullhorn, and on a later GET enroll (still unconnected) with a matching cookie,
show a recovery page (retry + manual fallback) rather than redirecting again.

**Why:** Any "detect the bounce" approach is impossible by construction; the
only observable event we control is the user re-opening the enrollment link.

**How to apply:** The cookie must be sameSite=lax (survives the top-level
return navigation) and the recovery/manual paths must stay token-gated so
crawlers never reach the Bullhorn password form (the pattern that previously got
the domain flagged "deceptive site"). Operationally: a stranded user must
re-click the enrollment link to surface the manual option — say so in support.
