/**
 * Shared in-memory OAuth state registry. Both the service-account flow and the
 * per-user enrollment flow generate states here and verify them in the shared
 * /api/auth/bullhorn/callback. States are one-time-use and expire after 15 min.
 *
 * State formats:
 *   Service account: <randomHex>
 *   User enrollment: user:<userId>:<randomHex>
 */

interface StateEntry {
  expires: number;
  firmId?: string;
}

const pendingStates = new Map<string, StateEntry>();
const STATE_TTL_MS = 15 * 60 * 1000;

export function rememberState(state: string, firmId?: string): void {
  const now = Date.now();
  for (const [key, entry] of pendingStates) {
    if (entry.expires <= now) pendingStates.delete(key);
  }
  pendingStates.set(state, { expires: now + STATE_TTL_MS, firmId });
}

export function consumeState(state: string): boolean {
  const entry = pendingStates.get(state);
  if (entry === undefined) return false;
  pendingStates.delete(state);
  return entry.expires > Date.now();
}

/** Returns the userId embedded in a user-enrollment state, or null. */
export function userIdFromState(state: string): string | null {
  if (!state.startsWith("user:")) return null;
  const parts = state.split(":");
  return parts[1] ?? null;
}

/**
 * Peek at the firmId associated with a state WITHOUT consuming it.
 * Must be called before consumeState.
 */
export function peekFirmId(state: string): string | null {
  const entry = pendingStates.get(state);
  return entry?.firmId ?? null;
}
