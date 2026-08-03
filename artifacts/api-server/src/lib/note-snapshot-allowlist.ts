/**
 * Configurable allowlist for which Note.action values are indexed in
 * note_action_snapshot. Scout Screen family first; expand via env without
 * schema changes.
 *
 * Env:
 *   NOTE_SNAPSHOT_ACTION_PREFIXES — comma-separated prefixes (default: "Scout Screen -")
 *     Set to empty string "" to disable all prefixes (exact list only).
 *   NOTE_SNAPSHOT_ACTIONS — comma-separated exact action strings (optional extras)
 */

const DEFAULT_PREFIXES = ["Scout Screen -"] as const;

function splitCsv(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Prefixes used when NOTE_SNAPSHOT_ACTION_PREFIXES is unset. */
export function defaultSnapshotActionPrefixes(): string[] {
  return [...DEFAULT_PREFIXES];
}

/**
 * Resolve active prefixes from env.
 * - unset → default Scout Screen family
 * - set to empty / whitespace only → no prefixes (exact actions only)
 * - otherwise → parsed list
 */
export function snapshotActionPrefixes(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!Object.prototype.hasOwnProperty.call(env, "NOTE_SNAPSHOT_ACTION_PREFIXES")) {
    return defaultSnapshotActionPrefixes();
  }
  return splitCsv(env.NOTE_SNAPSHOT_ACTION_PREFIXES);
}

export function snapshotExactActions(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return splitCsv(env.NOTE_SNAPSHOT_ACTIONS);
}

/** True when this Note.action should be upserted / served from the snapshot. */
export function isSnapshotIndexedAction(
  action: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const trimmed = action.trim();
  if (!trimmed) return false;
  for (const exact of snapshotExactActions(env)) {
    if (trimmed === exact) return true;
  }
  for (const prefix of snapshotActionPrefixes(env)) {
    if (trimmed.startsWith(prefix)) return true;
  }
  return false;
}

/** Default TTL for treating coverage as fresh enough for ChatGPT reports (2h). */
export const DEFAULT_NOTE_SNAPSHOT_TTL_MS = 2 * 60 * 60 * 1000;

export function noteSnapshotTtlMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.NOTE_SNAPSHOT_TTL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_NOTE_SNAPSHOT_TTL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_NOTE_SNAPSHOT_TTL_MS;
  return Math.floor(n);
}

export function isCoverageFresh(
  lastFullSyncAt: Date | null | undefined,
  nowMs: number = Date.now(),
  ttlMs: number = noteSnapshotTtlMs(),
): boolean {
  if (!lastFullSyncAt) return false;
  const syncMs = lastFullSyncAt.getTime();
  if (!Number.isFinite(syncMs)) return false;
  return nowMs - syncMs <= ttlMs;
}
