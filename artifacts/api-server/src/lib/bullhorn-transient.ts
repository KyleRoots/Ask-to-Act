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
 * Backoff before retry attempt n (1-indexed): 500ms, 1s, 2s (cap 4s).
 * Shorter than rate-limit backoff — gateway 504s often clear quickly.
 */
export function transientHttpBackoffMs(attempt: number): number {
  const n = Math.max(1, attempt);
  return Math.min(500 * Math.pow(2, n - 1), 4000);
}
