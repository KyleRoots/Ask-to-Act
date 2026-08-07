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

import { db, oauthStatesTable } from "@workspace/db";
import { eq, lt, sql } from "drizzle-orm";
import { logger } from "./logger.js";

const STATE_TTL_MS = 15 * 60 * 1000;

/** Best-effort purge of expired rows (called on remember). */
async function sweepExpired(): Promise<void> {
  try {
    await db.delete(oauthStatesTable).where(lt(oauthStatesTable.expiresAt, new Date()));
  } catch (err) {
    logger.warn({ err }, "oauth-state: expired sweep failed");
  }
}

export async function rememberState(state: string, firmId?: string): Promise<void> {
  const expiresAt = new Date(Date.now() + STATE_TTL_MS);
  // Opportunistic cleanup — no separate cron needed for this tiny table.
  void sweepExpired();
  await db
    .insert(oauthStatesTable)
    .values({
      state,
      firmId: firmId ?? null,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: oauthStatesTable.state,
      set: {
        firmId: firmId ?? null,
        expiresAt,
        createdAt: sql`now()`,
      },
    });
}

/**
 * One-time consume. Deletes the row (even if expired) so retries cannot
 * reuse a spent state. Returns true only when the row existed and was still
 * within TTL at consume time.
 */
export async function consumeState(state: string): Promise<boolean> {
  const deleted = await db
    .delete(oauthStatesTable)
    .where(eq(oauthStatesTable.state, state))
    .returning({ expiresAt: oauthStatesTable.expiresAt });

  if (deleted.length === 0) return false;
  return deleted[0]!.expiresAt.getTime() > Date.now();
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
  const rows = await db
    .select({ firmId: oauthStatesTable.firmId, expiresAt: oauthStatesTable.expiresAt })
    .from(oauthStatesTable)
    .where(eq(oauthStatesTable.state, state))
    .limit(1);

  const row = rows[0];
  if (!row || row.expiresAt.getTime() <= Date.now()) return null;
  return row.firmId ?? null;
}
