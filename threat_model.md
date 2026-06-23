# Threat Model

## Project Overview

AskToAct is a multi-tenant AI action layer for recruiting teams. Its public production deployment is an Express-based API server that exposes Bullhorn ATS data and actions through a remote MCP endpoint, a read-only REST mirror, Bullhorn OAuth enrollment routes, Clerk-backed portal APIs, and Stripe billing/webhook flows. The most sensitive assets are recruiter API keys, Bullhorn OAuth/session tokens, and the ATS data reachable through those credentials.

## Assets

- **Recruiter API keys** — long-lived bearer secrets that authenticate MCP and REST calls as a specific user. Compromise lets an attacker read ATS data and, for enrolled users, perform Bullhorn write actions as that recruiter.
- **Bullhorn tokens and sessions** — shared service-account refresh tokens plus per-user refresh/session material. Compromise enables direct access to Bullhorn data and actions outside normal portal controls.
- **Bullhorn ATS data** — candidate résumés, notes, contacts, jobs, submissions, placements, and related business data. This includes sensitive personal and employment information.
- **Portal identities and tenant membership** — Clerk sessions bridged to local users and firms. Mis-binding can expose one firm's reporting or workflow access to another firm.
- **Billing and firm metadata** — subscription state, seat limits, invite flows, firm branding, and support interactions. Tampering can enable unauthorized onboarding or conceal abusive usage.
- **Application secrets** — bearer admin token, Bullhorn OAuth client credentials, Stripe/SendGrid/Clerk secrets, and database credentials.

## Trust Boundaries

- **Internet → Express API** — all `/api/*` endpoints accept untrusted input from the public internet.
- **Bearer token / API key → application authority** — the server distinguishes between a high-privilege service token and per-user recruiter API keys; this boundary must be enforced on every route and write path.
- **Clerk session → local portal user** — portal access depends on correctly binding a Clerk identity to exactly one local user and firm.
- **API server → PostgreSQL** — database rows store API keys, tokens, and tenant metadata; improper query scoping or storage choices can expose those secrets.
- **API server → Bullhorn ATS** — the server can read and write highly sensitive ATS data. In the current architecture, read paths use a shared service-account Bullhorn session while writes use per-user Bullhorn sessions, making tenant isolation on read routes a top-risk area.
- **API server → third parties** — Stripe, Clerk, SendGrid, and Bullhorn each introduce callback, secret-handling, and outbound-request trust boundaries.
- **Production vs dev-only artifacts** — `artifacts/mockup-sandbox` is never production. Standalone frontend artifacts are lower-priority unless separately deployed or directly influencing production backend behavior.

## Scan Anchors

- Production entry points: `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/routes/*.ts`
- Highest-risk code: `artifacts/api-server/src/middlewares/bearer-auth.ts`, `artifacts/api-server/src/middlewares/clerk-user.ts`, `artifacts/api-server/src/lib/mcp-server.ts`, `artifacts/api-server/src/lib/bullhorn-auth.ts`, `artifacts/api-server/src/lib/bullhorn-client.ts`
- Public/authenticated/admin surfaces:
  - Public: `/api/mcp`, `/api/mcp/:token`, `/api/openapi.json`, Bullhorn OAuth callback/enrollment pages, Stripe webhook
  - Bearer-authenticated: `/api/v1/*`, most MCP reads/writes
  - Service-token-only: `/api/users*`, `/api/firms*`
  - Clerk-authenticated: `/api/portal/*`, `/api/support`
- Usually out of scope unless reachability changes: `artifacts/mockup-sandbox`, standalone frontend-only UX code not mounted on the public API deployment

## Threat Categories

### Spoofing

The application relies on three identity systems: a shared service bearer token, per-user recruiter API keys, and Clerk portal sessions. The system must reject malformed or misplaced credentials, bind each Clerk session to exactly one local user, and ensure Bullhorn write actions always execute under the intended enrolled recruiter identity rather than a shared service session.

### Tampering

Public callers can supply route params, query params, request bodies, OAuth inputs, and tool arguments. The server must validate these inputs, prevent callers from switching tenants or roles by parameter manipulation, and ensure billing, enrollment, and write workflows cannot be altered to act on behalf of another firm or recruiter.

### Information Disclosure

This project handles sensitive ATS data and multiple classes of secrets. API responses, caches, logs, generated links, and stored tokens must not expose recruiter API keys, Bullhorn tokens, or another firm's ATS data. Shared read-session design is especially sensitive because a caller's API key identity is currently not the same thing as the Bullhorn identity used for reads.

### Denial of Service

Because the deployment is public and autoscaled, unauthenticated and authenticated callers can trigger Bullhorn lookups, OAuth flows, and email/billing operations. The system must rate-limit expensive endpoints, avoid unbounded request amplification against Bullhorn or Stripe, and fail safely when upstream rate limits or authentication failures occur.

### Elevation of Privilege

The highest-risk failure mode is converting low-privilege or cross-tenant access into broader Bullhorn or admin authority. Service-token-only routes must stay isolated from recruiter API keys, portal routes must enforce firm-admin checks server-side, and write tools must never be reachable through the shared read-only service identity. Injection or credential-leak paths that let an attacker impersonate a recruiter or administrator also fall into this category.
