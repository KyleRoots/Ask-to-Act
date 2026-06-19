---
name: Bullhorn OAuth
description: How Bullhorn REST API authentication works for the MCP server and the constraints that shaped the design.
---

# Bullhorn OAuth flow

Bullhorn **retired the OAuth `password` (ROPC) grant** — token requests with
`grant_type=password` now return `unsupported_grant_type`. Auth must use the
**authorization_code** flow, then exchange the access token at
`/rest-services/login` for a `BhRestToken`, and use `refresh_token` for renewals.

**Why:** Bullhorn deprecated ROPC (no MFA/SSO support). Discovered when live
calls failed with `unsupported_grant_type` despite valid credentials.

## Hard constraints (these drove the design)
- **`redirect_uri` must EXACTLY match a value registered on the Bullhorn API key**
  (registration is controlled by Bullhorn Support / the key owner). A wrong value
  returns an HTML "Invalid Redirect URI" page (HTTP 200, not JSON). On that error
  page, blank `Client Id`/`Client Name` rows mean the client_id itself is
  unrecognized; populated rows mean the client is fine but the redirect mismatches.
  The same redirect_uri must be used in BOTH the authorize request and the token
  exchange.
- **First authorization shows an interactive "Get Consent" screen** (a POST form
  with Agree/Decline). Scripting the Agree POST server-side is unreliable (500s).
  Consent must be granted once in a real browser; afterward the refresh token
  works headlessly.
- Endpoints are data-center specific: resolve them per-user via
  `loginInfo?username=...` (`oauthUrl`, `restUrl`), don't hardcode the region.

**How to apply:** the robust design is a one-time **browser** authorization
(redirect the user to Bullhorn's authorize URL → callback receives the code →
store the rotated refresh token in Postgres), then refresh-token renewals for all
headless calls. Treat the persisted refresh token as the source of truth on
re-auth (it's rotated and re-persisted on every refresh). Do NOT send username/
password from the server in the authorize request — the user logs in interactively.

## Symptom: "Agree" bounces back to login, no code reaches the callback
If the user reaches the genuine "Get Consent" screen, clicks **Agree**, and is
returned to the Bullhorn login page while NO request hits `/callback` (verify in
workflow logs — only `/login` 302s appear), and consent is NOT recorded (the
consent screen reappears on every attempt), Bullhorn is failing to issue the code
at the consent step.
**Key inference — this is NOT a redirect_uri or client_id problem:** reaching the
login + "Get Consent" screen (instead of the "Invalid Redirect URI" / blank
Client Id HTML page) PROVES Bullhorn accepted both the client_id and the
redirect_uri at authorize time. So stop re-checking the redirect_uri — it's
correct. Confirmed reproducible across multiple login users (a normal user AND the
dedicated `*.api` user) and across browsers, so it is not browser/cookie- or
user-permission-specific in the obvious sense.
**Why (CONFIRMED by controlled test):** the API key / client_id is registered
under a DIFFERENT Bullhorn corporation than the login users. Swapping in a
known-good client registered under the correct corp made the SAME flow complete —
Bullhorn issued an authorization code immediately (visible as `?code=...` on the
redirect), while the bad client always bounced. So when the consent screen names a
corp (e.g. "Quality Temporary Services Inc. - 11119 - REST API") that doesn't match
the login user's corp, Bullhorn shows consent but cannot record it / issue a code
for a cross-corp grant and silently returns to login. Only Bullhorn can fix this
(re-associate the key with the correct corp, or issue a new key under it).
**Do NOT share one client across two apps** (e.g. this server + JobPulse): both
rotate the same refresh token on refresh and will invalidate each other. Use a
dedicated client per app.
**How to apply:** do NOT change our code — it's proven correct (authorize URL
decodes to the exact whitelisted redirect_uri, callback reachable, consent screen
reached). Escalate to Bullhorn Support: ask them to confirm the API key is
associated with the SAME corporation as the login users, and whether the corp
named on the consent screen matches the user's corp.

## Refinement: Agree still bounces even when the consent screen names a corp that LOOKS right
A re-issued key under a corp matching the user's company name is NOT sufficient.
Confirmed in a clean incognito session: a new dedicated key whose consent screen
read "Myticas BH1-28404" (a Myticas corp, not the old QTS corp), logged in as the
dedicated `myticasbh1.api` user, reached "Get Consent", clicked **Agree** → still
bounced to login, no code, status stayed `{connected:false}`. So matching the
*company name* is not enough — the grant fails unless the login user is a member of
the EXACT corporation/instance the key is bound to (the number after the name, e.g.
the `28404` corp id) AND has rights to grant OAuth consent.
**Two remaining root causes once the corp name looks right:** (a) the login user
belongs to a DIFFERENT Myticas corp/instance than the one the key is bound to
(consent screen shows the KEY's corp, not the user's, so it can still be a hidden
mismatch); or (b) the user is in the right corp but lacks the entitlement to grant
OAuth consent / use REST for that key. Both are Bullhorn-side only.
**How to apply:** give Bullhorn the exact corp id shown on the consent screen (e.g.
`28404`) and ask them to (1) confirm the login user is a member of THAT corp id,
and (2) confirm that user has permission to grant OAuth consent / REST access for
the key. A live phone call resolves this far faster than ticket round-trips.
