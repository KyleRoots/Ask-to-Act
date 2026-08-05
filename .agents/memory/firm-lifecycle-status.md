---
name: Firm lifecycle status (offboarding)
description: How firm suspend/archive cuts off the live AI-tool path; why it's separate from Stripe status.
---

# Firm lifecycle status

`firms.status` (text: active|suspended|archived, default active, DB CHECK constraint) is a
MANUAL offboarding lever, deliberately INDEPENDENT of Stripe `subscriptionStatus`. No auto-Stripe
wiring — an admin flips it from the admin UI.

**The cutoff that matters:** `requireBullhornFirm` (bearer-auth.ts) is the ONLY runtime gate that
blocks an already-enrolled firm's users. Subscription status is checked only at onboarding
(users add/enroll, firm detail) **unless** `ENTITLEMENTS_ENFORCED=1`, which also runs
`assertFirmEntitled` on this same live path (default OFF — see
[universal-connector-milestone-9.md](./universal-connector-milestone-9.md)). Lifecycle
(`firms.status`) always applies; billing entitlement is opt-in until Stripe is trusted.

**Why:** non-paying / offboarded firms whose users were already enrolled would otherwise keep
working forever, since the runtime path never re-checks billing.

**How to apply:**
- Gate is FAIL-CLOSED: `!firm || firm.status !== "active"` → 403. A missing firm row (orphaned user
  / data drift) must also be denied, not waved through.
- Service token bypasses (admins administer the connection itself).
- "archived" = suspended PLUS hidden from default `GET /firms` (use `?includeArchived=1` to see it).
  Both suspended and archived block tool access identically; archived only differs in list visibility.
- All transitions are reversible (set back to active). No hard delete exists or is wanted.
