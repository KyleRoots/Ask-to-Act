---
name: Bullhorn OAuth
description: How Bullhorn REST auth works for the MCP server, the headless consent breakthrough, and entity field/endpoint gotchas.
---

# Bullhorn OAuth flow (SOLVED — headless end-to-end, no browser)

Bullhorn **retired the OAuth `password` (ROPC) grant** (`grant_type=password` →
`unsupported_grant_type`). Auth uses the **authorization_code** flow, then
exchanges the access token at `/rest-services/login` for a `BhRestToken`, and uses
`refresh_token` for renewals. Resolve endpoints per-user via
`loginInfo?username=...` (`oauthUrl`, `restUrl`) — they are data-center specific,
never hardcode the region.

## THE BREAKTHROUGH: consent can be approved headlessly, server-side
The whole flow works with NO browser and NO human, including first-time consent:
1. `GET {oauthUrl}/authorize?client_id&response_type=code&redirect_uri&username&password&action=Login`
   with `redirect: manual`.
   - If consent was already recorded → you get a **302** whose `Location` carries `?code=...`.
   - First time for a client_id+user → you get **HTTP 200 with the "Get Consent"
     HTML page** (`<form name="consentForm">`, hidden `corporationId`/`masterUserId`/
     `expiresAt`, submit buttons `action=Agree`/`Decline`) and a `Set-Cookie:
     JSESSIONID=...; Path=/oauth`.
2. To grant consent, **POST the consent form back to the SAME authorize URL**
   (the form has no `action` attr, so it targets the current URL), sending the
   `JSESSIONID` cookie + the hidden fields + `action=Agree`, again `redirect:
   manual`. Bullhorn returns a **302 with `?code=...`**. Exchange that code for a
   token as normal. Consent is then recorded; future logins return the code
   directly from step 1.

**Why this matters:** the *interactive browser* "Agree" kept bouncing back to
login and never recorded consent (see history below) — that was treated for weeks
as a Bullhorn-side key/corp defect that "only Bullhorn can fix." It was a dead end.
**Doing the identical Agree POST server-side (full control of the cookie jar)
succeeds where the browser failed.** So: don't rely on the browser consent screen;
drive consent from the server.

**How to apply:** implemented in `bullhorn-auth.ts` (`fetchAuthCodeHeadless` →
`approveConsent`). Persist the rotated refresh token in Postgres and treat it as
the source of truth on re-auth (it rotates on every refresh). `reauthenticate()`
tries the refresh token first, then falls back to a full headless login+consent.

## Hard constraints
- **`redirect_uri` must EXACTLY match a value registered on the API key** (Bullhorn
  Support / key owner controls registration), used identically in BOTH the
  authorize request and the token exchange. A wrong value returns an HTML "Invalid
  Redirect URI" page (HTTP 200). Distinguish failure modes by the returned HTML:
  "Invalid Redirect URI" / blank Client Id = client_id or redirect problem;
  "Get Consent" page = client_id + redirect_uri are BOTH accepted and the
  credentials are VALID (you got past auth) — the only thing left is consent.
- **Don't share one client_id across two apps** — both rotate the same refresh
  token and invalidate each other. Use a dedicated client per app.

## Account LOCKOUT from repeated failed logins — self-unlock
Repeated failed auths exceed `failedLoginLockoutThreshold` and Bullhorn locks the
user (Account shows "Locked"); every password is then rejected before reaching
consent. Fix without Bullhorn support: a Super Admin opens the user record →
Account Information → flip **Locked → Unlocked**, set a fresh clean password, Save;
wait ~2-3 min. A single wrong attempt can re-lock it. When a previously-working
password suddenly fails, check Locked status FIRST. Guard automated login paths
with a cooldown/circuit-breaker so a bad credential can't hammer the account.

## Entity field & endpoint gotchas (corp 28404; from live 400s)
Bullhorn validates `fields` left-to-right and returns `Invalid field 'X' at
position N` for the FIRST bad one — fix iteratively off those messages (or query
the `meta/{Entity}` endpoint). Confirmed corrections vs. generic assumptions:
- **JobOrder**: use `dateEnd`, NOT `expiryDate`.
- **ClientCorporation**: use `numEmployees` (not `numStaff`); no `industry`, no
  `description`; uses `owners` (to-many), NOT `owner`. `revenue`, `fax` are valid.
- **ClientContact**: no `title`. `owner`, `mobile`, `clientCorporation` are valid.
- **Candidate**: work-history association is `workHistories` (plural, like
  `educations`), NOT `workHistory`.
- **Note is an INDEXED entity** → must be read via `/search` (Lucene `field:value`,
  e.g. `jobOrder.id:123`), NOT `/query`; its text field is `comments`, not `body`.
- **`/query` responses return `{start, count, data}` with NO `total` field**;
  `/search` responses DO include `total`. So for query-based entities (Placement,
  JobSubmission) you can't read a grand total from the response — rely on `count`
  (rows returned) and request a high enough `count`/page with `start`.
- **Date filtering**: `dateAdded` is epoch **milliseconds**. In `/query` `where`
  use numeric comparisons (`dateAdded >= <ms> AND dateAdded < <ms>`); in `/search`
  Lucene use a range (`dateAdded:[<ms> TO <ms>]`, inclusive both ends). Bullhorn
  `count` maxes at 500.

## History (kept for context; superseded by the headless solution above)
The browser "Agree" bounced back to login with no code, reproducibly, across users,
corps, and re-issued keys — even with a fully-correct user (REST-enabled Webservice
API usertype, Bullhorn IdP, enabled+unlocked, correct corp 28404, fresh password,
incognito). This was escalated as a key/consent-persistence defect. The server-side
consent POST (above) ultimately bypassed the entire browser problem.
