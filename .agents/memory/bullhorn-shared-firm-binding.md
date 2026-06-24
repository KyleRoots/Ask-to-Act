---
name: Shared Bullhorn token firm binding
description: Why all connector reads can 403 for a fully-enrolled user, and the one-call fix per tenant
---

# Shared Bullhorn token must be firm-bound or ALL user reads 403

The connector read path (`/api/v1/*` and the MCP read tools) is gated by
`requireBullhornFirm`. That gate compares the caller's `firmId` against the
firmId bound to the **shared** Bullhorn token row (`bullhorn_tokens`, single
row `id=default`). The reads themselves run through this shared service session,
NOT each user's personal Bullhorn session.

If the shared token row's `firm_id` is empty/null, EVERY user read returns:
`403 — "Bullhorn workspace is not yet bound to a firm."` — even for a user whose
own enrollment is fully complete (personal api_key + Bullhorn refresh token +
session all present). Per-user enrollment populates the user row's WRITE
credentials; it does NOT set the shared row's firm_id.

**Why:** tenant isolation — without a bound firmId the gate cannot prove the
caller belongs to the firm whose Bullhorn data the shared session reads, so it
fails closed.

**How to apply / fix:** this is a per-tenant onboarding step, NOT a code change.
Re-bind the shared connection with one service-token call:

```
POST https://connect.asktoact.ai/api/auth/bullhorn/connect?firmId=<firmId>
   Authorization: Bearer <MCP_BEARER_TOKEN>   # headless; uses env BH creds, no browser OAuth
```

`firmId` is the AskToAct **firm record id** (e.g. Myticas = `e44c50e3e95e698c`),
NOT the Bullhorn corp id (28404). The handler calls `connectHeadless(firmId)` →
`saveRefreshToken(token, firmId)`, writing `firm_id` to the shared row. Reads
unblock immediately for every user whose `users.firm_id` matches.

**Gotchas:**
- The service token (`MCP_BEARER_TOKEN`) value is NOT readable via `viewEnvVars`
  (existence only). It IS injected into the shell env — run the curl from bash
  using `$MCP_BEARER_TOKEN` so the value never enters agent context.
- Diagnose by reading Kyle-style with the user's own api_key against
  `/api/v1/reports/open-jobs`: 403 "not bound to a firm" = shared-token problem,
  401 = bad api_key, 200 = healthy. DB check: `SELECT firm_id FROM bullhorn_tokens`.
- Re-enrolling the user or issuing a fresh enroll link does NOT fix this.
