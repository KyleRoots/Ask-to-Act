---
name: CORS production origin policy
description: Why *.replit.app/*.repl.co are blocked from CORS in production, and how to add a legit off-domain browser client.
---

# CORS production origin policy

In `artifacts/api-server` `isAllowedOrigin()`, the broad Replit-hosted wildcards
(`*.replit.dev`, `*.replit.app`, `*.repl.co`) are trusted **only when
`NODE_ENV !== "production"`**. In production the allowlist is: `localhost`,
`asktoact.ai` / `*.asktoact.ai`, plus anything in the `ALLOWED_ORIGINS` env var.

**Why:** This is a single autoscale deployment with path-based routing. In prod
the portal and admin SPAs are served same-origin under `connect.asktoact.ai`
and call `/api/...` on their own origin, so CORS never applies to first-party
traffic. Non-browser callers (ChatGPT/Claude MCP) send no `Origin` header and
are allowed unconditionally by an early return before origin matching. Therefore
no `*.replit.app`/`*.repl.co` origin is a legitimate cross-origin caller in prod
— and allowing the wildcard let ANY Replit-deployed app make credentialed
cross-origin reads against a logged-in user.

**How to apply:** If a real off-domain browser client ever needs prod access,
add its exact origin to the `ALLOWED_ORIGINS` env var. Do NOT re-add the Replit
wildcards to "fix" a prod CORS error — that reintroduces the broad-origin
credentialed-read risk.

## Companion lesson: tighten DB column + app layer in lockstep
When you add `NOT NULL` / `UNIQUE` to an existing column, update EVERY insert
path, API validation, and UI in the same change. Otherwise a previously-valid
request (e.g. omitted email, or an ordinary duplicate) turns a clean 400/409
into a 500. For `users.email` (required because the Clerk bridge matches logins
by email): `POST /api/users` validates required+format → 400, pre-checks
duplicate → 409, and also catches Postgres `23505` in the insert catch so
concurrent duplicate creates are race-safe.
