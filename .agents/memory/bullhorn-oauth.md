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
workflow logs — only `/login` 302s appear), Bullhorn silently failed the
post-consent redirect. Consent is also NOT recorded (the consent screen reappears
on the next attempt). This is a **Bullhorn-server-side redirect_uri validation
failure at redirect time**, even when our authorize request sends the exact
whitelisted value and our callback is reachable from a browser.
**Why:** Bullhorn validates the stored redirect_uri when issuing the code; a
mismatch (trailing slash, scheme, or the whitelist applied to a different/duplicate
client record, or not yet propagated) makes it abort to login instead of erroring.
**How to apply:** don't keep changing our code — it's correct if the authorize URL
decodes to the exact whitelisted `redirect_uri` and a browser GET to `/callback`
returns our HTML. Rule out the browser (clean profile, extensions off), then send
the symptom back to Bullhorn Support and have them re-confirm the redirect_uri is
active on THAT client_id and the login user is entitled to it.
