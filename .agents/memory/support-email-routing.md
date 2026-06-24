---
name: Support email routing split
description: Why setting SUPPORT_EMAIL does not affect the onboarding "Ask for help" mailto, and what each support path requires.
---

# Support email routing has two independent paths

There are TWO ways a support message reaches us, and they route differently:

1. **App-generated tickets** — the `create_support_ticket` MCP tool calls
   `sendSupportEmail` (emailService.ts), which sends via SendGrid to
   `process.env.SUPPORT_EMAIL ?? "support@asktoact.ai"`. This path IS
   server-controlled: change `SUPPORT_EMAIL` to reroute it.

2. **The connector setup "Ask for help" form** (connector setup page in
   routes/users.ts) — NO LONGER a mailto. It is now an inline form that POSTs to
   the PUBLIC endpoint `POST /api/support/help` (routes/support.ts), which calls
   the same `sendSupportEmail` → `SUPPORT_EMAIL`. So this path IS now
   server-controlled too: `SUPPORT_EMAIL` reroutes it, no domain forwarding
   needed. The endpoint is unauthenticated with a dedicated rate limiter
   (5/10min/IP) + a honeypot field.

   **Why switched from mailto:** mailto depends on the user having a configured
   desktop mail client (often absent on web-only setups, so it silently does
   nothing), AND it required external domain mail forwarding (Cloudflare/registrar/
   Workspace) to ever reach us. The form sidesteps both by reusing the already-
   authorized SendGrid send path.

**Remaining mailto/inbound dependency:** Other `support@asktoact.ai` /
`CONTACT_EMAIL` mailtos still exist (e.g. routes/legal.ts) and STILL need domain
forwarding to be received. If asked to make support@asktoact.ai *receive* mail,
that is external to this repo (Cloudflare Email Routing / Workspace alias /
registrar forwarding). SendGrid being authorized only covers *sending*, not
receiving (inbound would need an MX change + Inbound Parse webhook).

**How to apply:** For in-app/help-form support routing, just set `SUPPORT_EMAIL`.
For any literal `mailto:support@asktoact.ai` link to deliver, set up domain-level
forwarding/alias on asktoact.ai.
