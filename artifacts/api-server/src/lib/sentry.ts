import * as Sentry from "@sentry/node";
import type { Breadcrumb, ErrorEvent } from "@sentry/node";
import { logger } from "./logger.js";

const SENSITIVE_QUERY_KEYS = new Set(["password", "client_secret", "code", "refresh_token"]);

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
    beforeBreadcrumb(breadcrumb) {
      return scrubSentryBreadcrumb(breadcrumb);
    },
    beforeSend(event) {
      return scrubSentryEvent(event);
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

function isHttpOrFetchBreadcrumb(breadcrumb: Breadcrumb): boolean {
  const type = (breadcrumb.type ?? "").toLowerCase();
  const category = (breadcrumb.category ?? "").toLowerCase();
  return (
    type === "http" ||
    type === "fetch" ||
    category === "http" ||
    category === "fetch" ||
    category.startsWith("http.") ||
    category.startsWith("fetch")
  );
}

function stripQuery(url: string): string {
  const queryAt = url.indexOf("?");
  return queryAt === -1 ? url : url.slice(0, queryAt);
}

function queryKeys(value: unknown): string[] {
  if (typeof value === "string") {
    const raw = value.startsWith("?") ? value.slice(1) : value;
    if (raw.includes("://")) {
      try {
        return [...new URL(raw).searchParams.keys()];
      } catch {
        return [...new URLSearchParams(raw).keys()];
      }
    }
    return [...new URLSearchParams(raw).keys()];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => (Array.isArray(item) && item.length > 0 ? [String(item[0])] : []));
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}

function hasSensitiveQuery(url: string, httpQuery: unknown): boolean {
  if (url.includes("/oauth/authorize") || url.includes("/oauth/token")) return true;
  const keys = [...queryKeys(url), ...queryKeys(httpQuery)];
  return keys.some((key) => SENSITIVE_QUERY_KEYS.has(key.toLowerCase()));
}

/**
 * Drops the query string from an http or fetch breadcrumb that would carry
 * Bullhorn OAuth material. Covers data.url and data["http.query"].
 * Other breadcrumbs are returned unchanged.
 */
export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (!isHttpOrFetchBreadcrumb(breadcrumb) || !breadcrumb.data) return breadcrumb;
  const url = typeof breadcrumb.data.url === "string" ? breadcrumb.data.url : "";
  const httpQuery = breadcrumb.data["http.query"];
  if (!hasSensitiveQuery(url, httpQuery)) return breadcrumb;

  const data: Record<string, unknown> = { ...breadcrumb.data };
  if (typeof data.url === "string") data.url = stripQuery(data.url);
  delete data["http.query"];
  return { ...breadcrumb, data };
}

function requestPath(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return stripQuery(url);
  }
}

function isSensitiveBullhornRequest(pathname: string): boolean {
  if (/^\/api\/firms\/[^/]+\/bullhorn-connect\/?$/.test(pathname)) return true;
  return /^\/api\/auth\/bullhorn(?:\/|$)/.test(pathname);
}

function redactPasswordKeys(value: unknown): unknown {
  if (typeof value === "string") {
    if (!/"password"\s*:/i.test(value)) return value;
    try {
      return JSON.stringify(redactPasswordKeys(JSON.parse(value)));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map((item) => redactPasswordKeys(item));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.toLowerCase() === "password") continue;
    out[key] = redactPasswordKeys(child);
  }
  return out;
}

function dataHasPasswordKey(value: unknown): boolean {
  if (typeof value === "string") return /"password"\s*:/i.test(value);
  if (Array.isArray(value)) return value.some((item) => dataHasPasswordKey(item));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => key.toLowerCase() === "password" || dataHasPasswordKey(child),
  );
}

/**
 * Removes Bullhorn connect and auth request bodies, and any password field
 * on other request bodies. Authorization and cookie headers are always removed.
 */
export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
  const request = event.request;
  if (!request) return event;

  if (request.headers) {
    delete request.headers["authorization"];
    delete request.headers["cookie"];
  }

  if (isSensitiveBullhornRequest(requestPath(request.url))) {
    delete request.data;
    delete request.query_string;
    if (typeof request.url === "string") request.url = stripQuery(request.url);
    return event;
  }

  if (request.data !== undefined && dataHasPasswordKey(request.data)) {
    request.data = redactPasswordKeys(request.data);
  }
  return event;
}

export { Sentry };
