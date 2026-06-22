/**
 * Shared in-memory OAuth state registry. Both the service-account flow and the
 * per-user enrollment flow generate states here and verify them in the shared
 * /api/auth/bullhorn/callback. States are one-time-use and expire after 15 min.
 *
 * State formats:
 *   Service account: <randomHex>
 *   User enrollment: user:<userId>:<randomHex>
 */

const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 15 * 60 * 1000;

export function rememberState(state: string): void {
  const now = Date.now();
  for (const [key, expires] of pendingStates) {
    if (expires <= now) pendingStates.delete(key);
  }
  pendingStates.set(state, now + STATE_TTL_MS);
}

export function consumeState(state: string): boolean {
  const expires = pendingStates.get(state);
  if (expires === undefined) return false;
  pendingStates.delete(state);
  return expires > Date.now();
}

/** Returns the userId embedded in a user-enrollment state, or null. */
export function userIdFromState(state: string): string | null {
  if (!state.startsWith("user:")) return null;
  const parts = state.split(":");
  return parts[1] ?? null;
}
