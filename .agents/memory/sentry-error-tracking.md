---
name: Sentry error tracking
description: Optional Sentry DSN wiring for api-server production errors.
---

# Sentry (AskToAct api-server)

## Behavior
- `artifacts/api-server/src/lib/sentry.ts` initializes `@sentry/node` only when `SENTRY_DSN` is set.
- `index.ts` imports/init before the Express app; captures unhandledRejection / uncaughtException.
- `app.ts` registers `Sentry.setupExpressErrorHandler` before the generic 500 handler when enabled.
- Authorization / Cookie headers are stripped in `beforeSend`. No tracing (`tracesSampleRate: 0`) until we deliberately opt in.

## Enable in production
1. Create a free Sentry project (platform: Node.js / Express) at https://sentry.io.
2. Copy the DSN (`https://…@….ingest.sentry.io/…`).
3. Set Railway secret `SENTRY_DSN` on `@workspace/api-server` / production (Runtime Secret).
4. Redeploy (or let the next main deploy pick it up). Startup log should include `Sentry error tracking enabled`.
5. Smoke: trigger a deliberate 500 in a non-prod environment, or wait for a real error — it should appear in Sentry Issues within a minute.

## Local / CI
Leave `SENTRY_DSN` unset. The app is unchanged; tests must not require Sentry.
