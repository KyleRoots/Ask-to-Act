/**
 * Tiny shared accessors for working with loosely-typed Bullhorn JSON records.
 * Centralized so the search-quality modules (taxonomy/ranking/verify/experience)
 * and the matcher don't each re-implement the same coercions.
 */

export function recordOf(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** Unwrap a single Bullhorn entity that may arrive wrapped as `{ data: {...} }`. */
export function entityOf(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && "data" in (v as object)) {
    const d = (v as { data?: unknown }).data;
    if (d && typeof d === "object" && !Array.isArray(d)) return d as Record<string, unknown>;
  }
  return recordOf(v);
}

export function str(v: unknown): string {
  if (typeof v === "string") return v;
  // Stringify primitives, but NEVER objects/arrays — a Bullhorn association field
  // (e.g. a to-many `skills`) must read as "" so callers fall back sensibly rather
  // than getting the literal "[object Object]".
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** Coerce to a finite number, or null. Bullhorn dates arrive as epoch-ms numbers. */
export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Unwrap either a raw array or a Bullhorn `{ data: [...] }` envelope. */
export function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object" && Array.isArray((v as { data?: unknown[] }).data)) {
    return (v as { data: unknown[] }).data;
  }
  return [];
}

/** Bounded-concurrency map that preserves input order in the output. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
