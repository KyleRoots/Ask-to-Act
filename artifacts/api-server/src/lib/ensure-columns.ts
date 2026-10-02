import { pool } from "@workspace/db";

/**
 * Idempotent schema migration: adds any new columns introduced after the
 * initial table creation. Uses ADD COLUMN IF NOT EXISTS so it is safe to run
 * on every startup. Only alters application tables (not Stripe-managed ones).
 */
export async function ensureColumns(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS enroll_token TEXT,
        ADD COLUMN IF NOT EXISTS enroll_token_expires_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS reconnect_email_sent_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS bullhorn_refresh_generation INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS bullhorn_refresh_outcome TEXT NOT NULL DEFAULT 'idle',
        ADD COLUMN IF NOT EXISTS bullhorn_refresh_attempt_id TEXT,
        ADD COLUMN IF NOT EXISTS bullhorn_refresh_lease_expires_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS bullhorn_refresh_uncertain_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS bullhorn_reconnect_notice_state TEXT NOT NULL DEFAULT 'idle',
        ADD COLUMN IF NOT EXISTS bullhorn_reconnect_notice_attempt_id TEXT,
        ADD COLUMN IF NOT EXISTS bullhorn_reconnect_notice_claimed_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS bullhorn_reconnect_notice_completed_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS bullhorn_reconnect_notice_error TEXT;
    `);

    await client.query(`
      ALTER TABLE bullhorn_tokens
        ADD COLUMN IF NOT EXISTS firm_id TEXT,
        ADD COLUMN IF NOT EXISTS auth_healthy BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS last_auth_error_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS last_auth_error TEXT,
        ADD COLUMN IF NOT EXISTS refresh_generation INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS refresh_outcome TEXT NOT NULL DEFAULT 'idle',
        ADD COLUMN IF NOT EXISTS refresh_attempt_id TEXT,
        ADD COLUMN IF NOT EXISTS refresh_lease_expires_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS refresh_uncertain_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS reconnect_notice_state TEXT NOT NULL DEFAULT 'idle',
        ADD COLUMN IF NOT EXISTS reconnect_notice_attempt_id TEXT,
        ADD COLUMN IF NOT EXISTS reconnect_notice_claimed_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS reconnect_notice_completed_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS reconnect_notice_error TEXT;
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_enroll_token_key
        ON users (enroll_token)
        WHERE enroll_token IS NOT NULL;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS oauth_states (
        state TEXT PRIMARY KEY NOT NULL,
        firm_id TEXT,
        expected_generation INTEGER,
        claim_attempt_id TEXT,
        claimed_at TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT now()
      );
    `);
    await client.query(`
      ALTER TABLE oauth_states
        ADD COLUMN IF NOT EXISTS expected_generation INTEGER,
        ADD COLUMN IF NOT EXISTS claim_attempt_id TEXT,
        ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP;
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS oauth_states_expires_at_idx
        ON oauth_states (expires_at);
    `);
    await client.query(`
      ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
    `).catch(() => {
      /* already enabled or unsupported in some local DBs */
    });

    console.info("[db] ensureColumns: schema columns verified/applied");
  } catch (err) {
    console.warn("[db] ensureColumns: migration warning —", (err as Error).message);
    throw err;
  } finally {
    client.release();
  }
}
