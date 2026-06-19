import { logger } from "./logger.js";

interface CacheEntry {
  value: string;
  expiresAt: number;
}

/**
 * Tiny TTL + LRU in-memory cache for read-tool responses. Bounded by
 * `maxEntries` with oldest-first eviction; entries expire after `ttlMs`.
 *
 * The cache is process-local (not shared across instances). That is fine for a
 * read-only MCP server: it absorbs repeated identical reads from an assistant
 * within a short window, collapsing the cold-start auth + Bullhorn round-trip
 * into a single upstream call. Only successful results are ever stored, so a
 * transient Bullhorn failure is never cached.
 */
export class ResponseCache {
  private readonly store = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  get enabled(): boolean {
    return this.ttlMs > 0 && this.maxEntries > 0;
  }

  get(key: string): string | undefined {
    if (!this.enabled) return undefined;
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Touch for LRU recency: re-insert so it becomes the most-recently used.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string): void {
    if (!this.enabled) return;
    if (this.store.has(key)) this.store.delete(key);
    while (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Deterministic cache key for a tool's arguments. Keys are sorted recursively so
 * argument order never changes the key, and `undefined` values are dropped by
 * JSON.stringify (so an omitted optional and an explicit `undefined` collapse to
 * the same key).
 */
export function stableKey(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      return Object.keys(obj)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = obj[k];
          return acc;
        }, {});
    }
    return v;
  });
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 500;

const ttlMs = envInt("CACHE_TTL_MS", DEFAULT_TTL_MS);
const maxEntries = envInt("CACHE_MAX_ENTRIES", DEFAULT_MAX_ENTRIES);

logger.info(
  { ttlMs, maxEntries, enabled: ttlMs > 0 && maxEntries > 0 },
  "MCP response cache configured",
);

/** Process-wide singleton cache shared across all per-request MCP servers. */
export const responseCache = new ResponseCache(ttlMs, maxEntries);
