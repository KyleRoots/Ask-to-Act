/**
 * Short, user-visible error text for OAuth / upstream failures.
 * Truncates and strips credential-like substrings. Full detail stays in logs.
 */

const SECRETISH =
  /\b(Bearer\s+\S+|client_secret=[^&\s]+|refresh_token=[^&\s]+|access_token=[^&\s]+|password=[^&\s]+|BhRestToken=[^&\s]+)\b/gi;

/** Long opaque tokens / keys that sometimes appear in upstream HTML or JSON. */
const LONG_TOKEN = /\b[A-Za-z0-9_\-./+=]{48,}\b/g;

export function publicErrorReason(
  err: unknown,
  fallback: string,
  maxLen = 180,
): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const scrubbed = raw
    .replace(SECRETISH, "[redacted]")
    .replace(LONG_TOKEN, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();

  const text = scrubbed.length > 0 ? scrubbed : fallback;
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}
