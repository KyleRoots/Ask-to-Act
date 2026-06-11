---
name: Bullhorn OAuth
description: How Bullhorn REST API authentication works for the MCP server and why the password grant no longer works.
---

# Bullhorn OAuth flow

Bullhorn **retired the OAuth `password` (ROPC) grant** — token requests with
`grant_type=password` now return `unsupported_grant_type`. The server must use
the **authorization_code** flow, then exchange the access token at
`/rest-services/login` for a `BhRestToken`, and use `refresh_token` for renewals.

**Why:** Bullhorn deprecated ROPC for security (no MFA/SSO support). Discovered
when live calls failed with `unsupported_grant_type` despite valid credentials.

**How to apply:**
- Resolve data-center endpoints via `loginInfo?username=...` → use `oauthUrl`
  (e.g. `auth-east.bullhornstaffing.com/oauth`) and `restUrl` (append `/login`).
- Authorize: `GET {oauthUrl}/authorize?client_id&response_type=code&action=Login&username&password&redirect_uri&state`.
  Read the `code` from the **302 Location header without following it**. Node's
  global `fetch` turns manual redirects opaque (no headers), so use `node:https`.
- `redirect_uri` is optional ONLY if the client has exactly one registered URI,
  but **must exactly match** a registered value when supplied. A wrong value
  yields an HTML "Invalid Redirect URI" page (HTTP 200, not JSON).
- Diagnosing the error page: blank `Client Id`/`Client Name` rows = the client_id
  itself is unrecognized; populated rows = client OK but redirect mismatch.
- **Consent gate:** first authorization for a client+user shows a "Get Consent"
  POST form (`action=Agree/Decline`, hidden `corporationId`/`masterUserId`).
  Scripting the Agree POST is unreliable (returns 500). Grant consent ONCE in a
  real browser; afterward headless logins return the code directly.
- The robust foundation is a one-time browser OAuth (login + callback that stores
  the refresh_token), then refresh-token renewals for all headless MCP calls.
