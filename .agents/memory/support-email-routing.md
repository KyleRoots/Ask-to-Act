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

2. **The onboarding "Ask for help" mailto** (connector setup + enroll pages in
   routes/users.ts) — a plain `mailto:support@asktoact.ai` link. It opens the
   recruiter's OWN email client and never touches our server, so `SUPPORT_EMAIL`
   has zero effect on it.

**Why this matters:** "route support@asktoact.ai to <inbox>" can only be fully
satisfied for path #1 in code. Path #2 (the mailto) requires a mailbox
forwarding/alias rule on the **asktoact.ai domain** at the email provider
(Google Workspace / Cloudflare Email Routing / registrar) — that is external to
this repo and cannot be set from the codebase.

**How to apply:** If asked to redirect support email, set `SUPPORT_EMAIL` for the
app path AND either (a) have the user configure domain forwarding for the mailto
path, or (b) change the mailto `to` address directly (tradeoff: exposes a
non-brand personal address in the recruiter's email client).
