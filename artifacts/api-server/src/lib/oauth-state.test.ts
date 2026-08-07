import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { db, oauthStatesTable } from "@workspace/db";
import { like } from "drizzle-orm";
import {
  rememberState,
  consumeState,
  peekFirmId,
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
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);
  await cleanup();
});
afterAll(cleanup);
beforeEach(cleanup);

describe("oauth-state (durable)", () => {
  it("remembers and peeks firmId, then consumes once", async () => {
    const state = `${PREFIX}svc-1`;
    await rememberState(state, "firm-abc");
    expect(await peekFirmId(state)).toBe("firm-abc");
    expect(await consumeState(state)).toBe(true);
    expect(await peekFirmId(state)).toBeNull();
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
    await db.insert(oauthStatesTable).values({
      state,
      firmId: "firm-x",
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(await peekFirmId(state)).toBeNull();
    expect(await consumeState(state)).toBe(false);
  });
});
