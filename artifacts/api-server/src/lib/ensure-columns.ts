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
        ADD COLUMN IF NOT EXISTS enroll_token_expires_at TIMESTAMP;
    `);

    await client.query(`
      ALTER TABLE bullhorn_tokens
        ADD COLUMN IF NOT EXISTS firm_id TEXT,
        ADD COLUMN IF NOT EXISTS auth_healthy BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS last_auth_error_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS last_auth_error TEXT;
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_enroll_token_key
        ON users (enroll_token)
        WHERE enroll_token IS NOT NULL;
    `);

    console.info("[db] ensureColumns: schema columns verified/applied");
  } catch (err) {
    console.warn("[db] ensureColumns: migration warning —", (err as Error).message);
    throw err;
  } finally {
    client.release();
  }
}
