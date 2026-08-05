/**
 * Transient Bullhorn/gateway HTTP statuses safe to retry on read paths.
 * Do not use for non-idempotent writes (POST/PUT/DELETE) without care.
 */

/** Gateway / Bullhorn upstream blips observed during note-snapshot sync. */
export const TRANSIENT_BULLHORN_HTTP_STATUSES = new Set([502, 503, 504]);

/** Bounded retries for transient HTTP (after the first attempt). */
export const TRANSIENT_HTTP_MAX_RETRIES = 3;

export function isTransientBullhornHttpStatus(status: number): boolean {
  return TRANSIENT_BULLHORN_HTTP_STATUSES.has(status);
}

/**
 * Bullhorn answers 500 (not 502/503/504) when its own REST tier cannot reach an
 * internal backend — e.g. `Could not access HTTP invoker remote service at
 * [http://localhost:8083/data-services-4.0/sr/SelectBuilder]; nested exception is
 * org.apache.http.NoHttpResponseException`. Status alone cannot separate that
 * blip from a genuine 500 (bad query, unsupported field), so match the Java
 * connectivity exception in the body. Keep these patterns tied to transport
 * failures; never add request-shape errors, which must not be retried.
 */
const TRANSIENT_BULLHORN_BODY_PATTERNS: RegExp[] = [
  /Could not access HTTP invoker remote service/i,
  /NoHttpResponseException/i,
  /failed to respond/i,
  /ConnectException/i,
  /SocketTimeoutException/i,
  /SocketException/i,
  /Connection (?:reset|refused|timed out)/i,
  /Read timed out/i,
];

/** True when a Bullhorn error body names an upstream transport failure. */
export function isTransientBullhornErrorBody(body: string | null | undefined): boolean {
  if (!body) return false;
  return TRANSIENT_BULLHORN_BODY_PATTERNS.some((re) => re.test(body));
}

/**
 * Retry decision for a non-ok Bullhorn read response. Gateway statuses retry on
 * status alone; 500 retries only when the body names an upstream transport
 * failure.
 */
export function isTransientBullhornResponse(
  status: number,
  body?: string | null,
): boolean {
  if (isTransientBullhornHttpStatus(status)) return true;
  if (status === 500) return isTransientBullhornErrorBody(body);
  return false;
}

/**
 * Backoff before retry attempt n (1-indexed): 500ms, 1s, 2s (cap 4s).
 * Shorter than rate-limit backoff — gateway 504s often clear quickly.
 */
export function transientHttpBackoffMs(attempt: number): number {
  const n = Math.max(1, attempt);
  return Math.min(500 * Math.pow(2, n - 1), 4000);
}
