/**
 * Shared durable OAuth state registry. Both the service-account flow and the
 * per-user enrollment flow generate states here and verify them in the shared
 * /api/auth/bullhorn/callback (and M365 mailbox connect). States are
 * one-time-use and expire after 15 min.
 *
 * Persisted in Postgres so authorize and callback can land on different
 * Railway instances without flaking.
 *
 * State formats:
 *   Service account: <randomHex>
 *   User enrollment: user:<userId>:<randomHex>
 *   Mailbox connect: mailbox:<userId>:<randomHex>
 */

import { pool } from "@workspace/db";
import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";

const STATE_TTL_MS = 15 * 60 * 1000;

/** Best-effort purge of expired rows (called on remember). */
async function sweepExpired(): Promise<void> {
  try {
    await pool.query("DELETE FROM oauth_states WHERE expires_at < $1", [new Date()]);
  } catch (err) {
    logger.warn({ err }, "oauth-state: expired sweep failed");
  }
}

export async function rememberState(
  state: string,
  firmId?: string,
  expectedGeneration?: number | null,
): Promise<void> {
  const expiresAt = new Date(Date.now() + STATE_TTL_MS);
  // Opportunistic cleanup — no separate cron needed for this tiny table.
  void sweepExpired();
  await pool.query(
    `
      INSERT INTO oauth_states (
        state,
        firm_id,
        expected_generation,
        expires_at
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (state) DO UPDATE
      SET firm_id = EXCLUDED.firm_id,
          expected_generation = EXCLUDED.expected_generation,
          claim_attempt_id = NULL,
          claimed_at = NULL,
          expires_at = EXCLUDED.expires_at,
          created_at = now()
    `,
    [state, firmId ?? null, expectedGeneration ?? null, expiresAt],
  );
}

export type ClaimedOauthState = {
  firmId: string | null;
  expectedGeneration: number | null;
  attemptId: string;
};

/**
 * Bullhorn-only pre-exchange claim. This prevents duplicate callbacks from
 * performing duplicate provider exchanges. The row is still deleted only after
 * the token replacement succeeds, so the state consumption and credential
 * replacement can be treated as one logical completion.
 */
export async function claimStateForExchange(state: string): Promise<ClaimedOauthState | null> {
  const attemptId = randomUUID();
  const claimed = await pool.query<{
    firm_id: string | null;
    expected_generation: number | null;
  }>(
    `
      UPDATE oauth_states
      SET claim_attempt_id = $2,
          claimed_at = now()
      WHERE state = $1
        AND expires_at > now()
        AND claimed_at IS NULL
      RETURNING firm_id, expected_generation
    `,
    [state, attemptId],
  );

  const row = claimed.rows[0];
  if (!row) return null;
  return {
    firmId: row.firm_id ?? null,
    expectedGeneration: row.expected_generation ?? null,
    attemptId,
  };
}

export async function deleteClaimedState(state: string, attemptId: string): Promise<boolean> {
  const deleted = await pool.query(
    `
      DELETE FROM oauth_states
      WHERE state = $1
        AND claim_attempt_id = $2
    `,
    [state, attemptId],
  );
  return deleted.rowCount === 1;
}

/**
 * One-time consume. Deletes the row (even if expired) so retries cannot
 * reuse a spent state. Returns true only when the row existed and was still
 * within TTL at consume time.
 */
export async function consumeState(state: string): Promise<boolean> {
  const deleted = await pool.query<{ valid: boolean }>(
    "DELETE FROM oauth_states WHERE state = $1 RETURNING expires_at > now() AS valid",
    [state],
  );

  const row = deleted.rows[0];
  if (!row) return false;
  return row.valid;
}

/** Returns the userId embedded in a user-enrollment state, or null. */
export function userIdFromState(state: string): string | null {
  if (!state.startsWith("user:")) return null;
  const parts = state.split(":");
  return parts[1] ?? null;
}

/**
 * Peek at the firmId associated with a state WITHOUT consuming it.
 * Prefer calling before consumeState on the same request.
 */
export async function peekFirmId(state: string): Promise<string | null> {
  const result = await pool.query<{ firm_id: string | null }>(
    `
      SELECT firm_id
      FROM oauth_states
      WHERE state = $1
        AND expires_at > now()
      LIMIT 1
    `,
    [state],
  );

  const row = result.rows[0];
  if (!row) return null;
  return row.firm_id ?? null;
}

export async function peekExpectedGeneration(state: string): Promise<number | null> {
  const result = await pool.query<{
    expected_generation: number | null;
  }>(
    `
      SELECT expected_generation
      FROM oauth_states
      WHERE state = $1
        AND expires_at > now()
      LIMIT 1
    `,
    [state],
  );

  const row = result.rows[0];
  if (!row) return null;
  return row.expected_generation ?? null;
}
