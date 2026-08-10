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
export function isTransientBullhornErrorBody(
  body: string | null | undefined,
): boolean {
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
 * Network-layer failures where `fetch` rejects instead of answering, so there is
 * no status or body to classify. undici reports these as `TypeError: fetch
 * failed` and puts the real reason on `cause` (`ECONNRESET`, `EAI_AGAIN`, …).
 * The request never reached Bullhorn's application tier, which makes them the
 * same class of blip as a gateway 502 — safe to retry on idempotent reads.
 */
const TRANSIENT_FETCH_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Reasons that only ever appear as a message. `terminated` is undici cutting a
 * response body mid-stream; the rest are socket teardowns without a code.
 */
const TRANSIENT_FETCH_MESSAGE_PATTERNS: RegExp[] = [
  /fetch failed/i,
  /socket hang up/i,
  /^terminated$/i,
  /other side closed/i,
  /Client network socket disconnected/i,
];

/** Walks the `cause` chain, depth-capped so a self-referencing cause can't loop. */
function errorChain(err: unknown, maxDepth = 5): unknown[] {
  const chain: unknown[] = [];
  let current = err;
  for (let depth = 0; depth < maxDepth && current != null; depth++) {
    if (chain.includes(current)) break;
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "";
}

/**
 * True when a rejected `fetch` failed at the network layer rather than
 * returning an error response. An `AbortError` is never transient — the caller
 * cancelled deliberately (wall-clock budget), so retrying would defeat the wall.
 */
export function isTransientFetchError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const chain = errorChain(err);
  if (
    chain.some((link) => (link as { name?: unknown }).name === "AbortError")
  ) {
    return false;
  }
  return chain.some((link) => {
    const code = errorCode(link);
    if (code !== undefined && TRANSIENT_FETCH_ERROR_CODES.has(code))
      return true;
    const message = errorMessage(link);
    return TRANSIENT_FETCH_MESSAGE_PATTERNS.some((re) => re.test(message));
  });
}

/**
 * Flattens a rejected `fetch` into one diagnosable line. A bare
 * `TypeError: fetch failed` is useless in an ops alert — the actionable part
 * (`ECONNRESET` vs `EAI_AGAIN`) only lives on `cause`, and `Error.message`
 * alone is what reaches `note_snapshot_coverage.error_summary`. Never include
 * the request URL: it carries a `BhRestToken`.
 */
export function describeFetchError(err: unknown): string {
  const chain = errorChain(err);
  const parts: string[] = [];
  for (const link of chain) {
    const code = errorCode(link);
    const message = errorMessage(link);
    const label = code !== undefined ? `${code}: ${message}` : message;
    const trimmed = label.trim();
    if (trimmed.length > 0 && !parts.includes(trimmed)) parts.push(trimmed);
  }
  if (parts.length === 0) return "unknown fetch failure";
  const [head, ...causes] = parts;
  return causes.length > 0 ? `${head} (${causes.join("; ")})` : head;
}

/**
 * Backoff before retry attempt n (1-indexed): 500ms, 1s, 2s (cap 4s).
 * Shorter than rate-limit backoff — gateway 504s often clear quickly.
 */
export function transientHttpBackoffMs(attempt: number): number {
  const n = Math.max(1, attempt);
  return Math.min(500 * Math.pow(2, n - 1), 4000);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs an idempotent Bullhorn read, retrying failures that happen *before* a
 * response exists. Callers already retry transient statuses off `res.status`,
 * but a rejected `fetch` never reaches that check, so one DNS/socket blip
 * mid-walk used to fail a whole note-snapshot department.
 *
 * Budgeted independently of the status-based retries: the failure modes are
 * independent and the bound stays small (3 retries, ≤4s backoff each).
 * On exhaustion the reason is folded into `Error.message`, because callers such
 * as note-snapshot sync persist only the message and a bare `fetch failed` is
 * not diagnosable. Never pass the request URL in here for logging — Bullhorn
 * read URLs carry a `BhRestToken`.
 *
 * `sleep` is injectable so tests do not wait out real backoff.
 */
export async function fetchWithTransientRetry(
  attemptFetch: () => Promise<Response>,
  hooks: {
    onRetry?: (info: {
      attempt: number;
      delayMs: number;
      reason: string;
    }) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<Response> {
  const sleep = hooks.sleep ?? defaultSleep;
  let remaining = TRANSIENT_HTTP_MAX_RETRIES;
  for (;;) {
    try {
      return await attemptFetch();
    } catch (err) {
      if (!isTransientFetchError(err) || remaining === 0) {
        throw new Error(
          `Bullhorn request failed before a response: ${describeFetchError(err)}`,
          { cause: err },
        );
      }
      const attempt = TRANSIENT_HTTP_MAX_RETRIES - remaining + 1;
      const delayMs = transientHttpBackoffMs(attempt);
      hooks.onRetry?.({ attempt, delayMs, reason: describeFetchError(err) });
      await sleep(delayMs);
      remaining -= 1;
    }
  }
}
