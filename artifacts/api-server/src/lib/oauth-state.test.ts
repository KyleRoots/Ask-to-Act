import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { db, oauthStatesTable } from "@workspace/db";
import { like } from "drizzle-orm";
import {
  rememberState,
  claimStateForExchange,
  consumeState,
  deleteClaimedState,
  peekFirmId,
  peekExpectedGeneration,
  userIdFromState,
} from "./oauth-state.js";

const PREFIX = "test-oauth-state-";

async function cleanup() {
  await db.delete(oauthStatesTable).where(like(oauthStatesTable.state, `${PREFIX}%`));
}

beforeAll(async () => {
  const { pool } = await import("@workspace/db");
  await pool.query(`
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
  await pool.query(`
    ALTER TABLE oauth_states
      ADD COLUMN IF NOT EXISTS expected_generation INTEGER,
      ADD COLUMN IF NOT EXISTS claim_attempt_id TEXT,
      ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP;
  `);
  await cleanup();
});
afterAll(cleanup);
beforeEach(cleanup);

describe("oauth-state (durable)", () => {
  it("remembers and peeks firmId, then consumes once", async () => {
    const state = `${PREFIX}svc-1`;
    await rememberState(state, "firm-abc", 4);
    expect(await peekFirmId(state)).toBe("firm-abc");
    expect(await peekExpectedGeneration(state)).toBe(4);
    expect(await consumeState(state)).toBe(true);
    expect(await peekFirmId(state)).toBeNull();
    expect(await consumeState(state)).toBe(false);
  });

  it("claims Bullhorn exchange once and deletes only the matching claim", async () => {
    const state = `${PREFIX}claim`;
    await rememberState(state, "firm-abc", 9);
    const claim = await claimStateForExchange(state);
    expect(claim).toMatchObject({ firmId: "firm-abc", expectedGeneration: 9 });
    expect(await claimStateForExchange(state)).toBeNull();
    expect(await deleteClaimedState(state, "wrong-attempt")).toBe(false);
    expect(await deleteClaimedState(state, claim!.attemptId)).toBe(true);
    expect(await consumeState(state)).toBe(false);
  });

  it("returns null firmId when none was stored", async () => {
    const state = `${PREFIX}nofirm`;
    await rememberState(state);
    expect(await peekFirmId(state)).toBeNull();
    expect(await consumeState(state)).toBe(true);
  });

  it("parses user enrollment state ids without DB", () => {
    expect(userIdFromState(`user:uid-42:${PREFIX}r`)).toBe("uid-42");
    expect(userIdFromState(`${PREFIX}plain`)).toBeNull();
  });

  it("rejects expired state on consume", async () => {
    const state = `${PREFIX}expired`;
    const { pool } = await import("@workspace/db");
    await pool.query(
      `
        INSERT INTO oauth_states (state, firm_id, expires_at)
        VALUES ($1, 'firm-x', now() - interval '1 minute')
      `,
      [state],
    );
    expect(await peekFirmId(state)).toBeNull();
    expect(await consumeState(state)).toBe(false);
  });
});
