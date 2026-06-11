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
**Why (leading cause):** the API key / client_id is registered under a DIFFERENT
Bullhorn corporation than the login users. The consent screen names the key's
owning corp (e.g. "Quality Temporary Services Inc. - 11119 - REST API"); if the
login accounts live in a different corp, Bullhorn shows consent but cannot record
it / issue a code for a cross-corp grant, so it silently returns to login. Only
Bullhorn can fix this (re-issue the key under the correct corp, or entitle the
users). Other possible-but-less-likely causes: the users lack "grant OAuth
consent" rights for that key, or a Bullhorn-side consent-write bug.
**How to apply:** do NOT change our code — it's proven correct (authorize URL
decodes to the exact whitelisted redirect_uri, callback reachable, consent screen
reached). Escalate to Bullhorn Support: ask them to confirm the API key is
associated with the SAME corporation as the login users, and whether the corp
named on the consent screen matches the user's corp.
