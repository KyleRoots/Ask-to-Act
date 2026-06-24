---
name: Onboarding "enrolled" signal
description: refreshToken is the single source of truth for whether a user has completed onboarding — across the enroll page AND the admin user list.
---

# Onboarding "enrolled" signal

A user's `refreshToken` (Bullhorn OAuth refresh token) is THE signal for "this user
has finished onboarding / connected Bullhorn". Two independent places key on it:
- `GET /api/auth/user/enroll` shows the connector-setup page (skips the credentials
  flow) IFF `refreshToken` is present; otherwise it runs the enrollment path.
- `GET /api/users` reports `enrolled` = `refreshToken !== null`.

**Why it matters:** any feature that "resets a user to first-time state" (e.g. the admin
reset-onboarding action) MUST null `refreshToken` or the user will still be treated as
onboarded. The other connection fields (`bhRestToken`, `restUrl`, `tokenExpiresAt`,
`sessionExpiresAt`) are session cache — clearing them is good hygiene but does NOT change
the onboarded/enrolled verdict on its own.

**How to apply:** if you ever add a NEW field that represents an established connection,
decide explicitly whether the enroll flow / `enrolled` flag should also key on it, and make
sure the reset path clears it in lockstep. Also drop the in-memory session via
`invalidateUserSession(id)`, and rotate `apiKey` if you want the connector URL to be freshly
issued like a brand-new signup.
