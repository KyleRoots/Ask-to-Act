import * as Sentry from "@sentry/node";
import { logger } from "./logger.js";

/**
 * Optional Sentry error tracking.
 *
 * No-op when SENTRY_DSN is unset (local/dev/CI stay quiet). Production should
 * set SENTRY_DSN on Railway; without it the app still runs and only logs locally.
 *
 * Init MUST run before the Express app is imported so early load failures can
 * be reported — see the side-effect import at the top of index.ts.
 */
export function initSentry(): void {
  const dsn = process.env["SENTRY_DSN"]?.trim();
  if (!dsn) {
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env["NODE_ENV"] ?? "development",
    release: process.env["RAILWAY_GIT_COMMIT_SHA"] ?? process.env["npm_package_version"],
    // Errors only for now — no performance/tracing cost until we opt in.
    tracesSampleRate: 0,
    // Drop noisy health probes and keep PII out of event payloads by default.
    ignoreErrors: ["Too many requests, please try again later."],
    beforeSend(event) {
      if (event.request?.headers) {
        delete event.request.headers["authorization"];
        delete event.request.headers["cookie"];
      }
      return event;
    },
  });

  logger.info("Sentry error tracking enabled");
}

/** True when a DSN was configured and Sentry.init ran. */
export function isSentryEnabled(): boolean {
  return Boolean(process.env["SENTRY_DSN"]?.trim());
}

/**
 * Captures an unhandled error. Safe to call when Sentry is disabled —
 * Sentry.captureException is a no-op without an active client in practice,
 * but we still gate for clarity.
 */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!isSentryEnabled()) return;
  Sentry.withScope((scope) => {
    if (context) {
      scope.setExtras(context);
    }
    Sentry.captureException(err);
  });
}

export { Sentry };
