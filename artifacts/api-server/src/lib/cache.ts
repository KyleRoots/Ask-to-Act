/**
 * In-memory caching for this strictly read-only server. Two layers share the
 * same idea (staffing metrics don't change second-to-second, and AI clients
 * repeat the same headline questions), at different points:
 *
 *  1. `responseCache` + `stableKey` — caches the FINAL formatted tool-response
 *     text per (tool name + arguments), used by the MCP tool runner.
 *  2. `cacheGet` / `cacheSet` — a generic value cache used at the Bullhorn HTTP
 *     layer so repeat search/query/count reads return without re-hitting Bullhorn.
 *
 * Generic values are structuredClone-d on store and read so callers that mutate a
 * response in place (deep-link enrichment, PII redaction) can never corrupt a
 * cached entry, and every cache hit yields an independent copy.
 */
const DEFAULT_TTL_MS = 120_000;
const MAX_ENTRIES = 500;

interface Entry {
  value: unknown;
  expires: number;
}

const store = new Map<string, Entry>();

/** Returns an independent copy of the cached value, or undefined if missing/expired. */
export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    store.delete(key);
    return undefined;
  }
  return structuredClone(entry.value) as T;
}

/** Drops every generic-cache entry whose key matches. Used after a write so the next read is fresh. */
export function cacheDeleteWhere(predicate: (key: string) => boolean): void {
  for (const key of store.keys()) {
    if (predicate(key)) store.delete(key);
  }
}

/** Stores an independent copy of the value with a TTL, evicting the oldest entry when full. */
export function cacheSet(key: string, value: unknown, ttlMs: number = DEFAULT_TTL_MS): void {
  if (!store.has(key) && store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { value: structuredClone(value), expires: Date.now() + ttlMs });
}

/** Recursively sorts object keys so equivalent arguments produce an identical key. */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    if (obj[k] !== undefined) out[k] = canonicalize(obj[k]);
  }
  return out;
}

/** Deterministic string encoding of arbitrary tool arguments for cache keying. */
export function stableKey(args: unknown): string {
  return JSON.stringify(canonicalize(args));
}

interface StringEntry {
  text: string;
  expires: number;
}

/**
 * Short-TTL cache of formatted tool-response TEXT, keyed by tool name + args.
 * Only successful results are cached by the caller; errors propagate uncached.
 */
class ResponseCache {
  private store = new Map<string, StringEntry>();

  get(key: string): string | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      this.store.delete(key);
      return undefined;
    }
    return entry.text;
  }

  set(key: string, text: string, ttlMs: number = DEFAULT_TTL_MS): void {
    if (!this.store.has(key) && this.store.size >= MAX_ENTRIES) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { text, expires: Date.now() + ttlMs });
  }

  deleteWhere(predicate: (key: string) => boolean): void {
    for (const key of this.store.keys()) {
      if (predicate(key)) this.store.delete(key);
    }
  }
}

/**
 * Drops cached Bullhorn reads and formatted tool responses for this firm when
 * the key contains one of the record ids (entity GET, that record's notes, or
 * a get_* tool call). Other firms' entries are left in place.
 */
export function invalidateFirmReadCache(firmId: string | null, ids: number[]): void {
  const prefix = `${firmId ?? "no-firm"}:`;
  const patterns = ids
    .filter((id) => Number.isInteger(id) && id > 0)
    .map((id) => new RegExp(`(^|[^0-9])${id}([^0-9]|$)`));
  if (patterns.length === 0) return;
  const hit = (key: string) => key.startsWith(prefix) && patterns.some((re) => re.test(key));
  cacheDeleteWhere(hit);
  responseCache.deleteWhere(hit);
}

export const responseCache = new ResponseCache();
