---
name: getBaseUrl REPLIT_DOMAINS production trap
description: REPLIT_DOMAINS in production = raw *.replit.app host; must never be used as a fallback for external-facing absolute links.
---

# getBaseUrl: REPLIT_DOMAINS production trap

## The rule
In production, `REPLIT_DOMAINS` resolves to the raw `*.replit.app` deploy host (e.g.
`asktoact.replit.app`), NOT the custom branded domain. Any absolute link (enrollment
URL, Stripe callbacks, email links, etc.) built from `getBaseUrl()` must **never** fall
back to `REPLIT_DOMAINS` in production.

## Why
We shipped an invite email where the enrollment link showed `https://asktoact.replit.app/api/auth/user/enroll?token=...`
instead of `https://connect.asktoact.ai/...` because `PROD_URL` env var was unset in
the deployment and the code fell through to `REPLIT_DOMAINS[0]`. The email footer
(hardcoded `connect.asktoact.ai` constant in `emailService.ts`) looked correct while
the actual enroll link didn't — confusing and unprofessional for a pilot customer.

## How to apply
`getBaseUrl()` production branch must be: `PROD_URL ?? "https://connect.asktoact.ai"` —
no REPLIT_DOMAINS step. Set `PROD_URL=https://connect.asktoact.ai` as a production env
var for belt-and-suspenders. If a new deployment ever needs a different custom domain,
set `PROD_URL` accordingly.

Enrollment route (for reference): `GET /api/auth/user/enroll?token=...` (NOT `/api/auth/n`
— earlier session grep output was corrupted/transformed).
