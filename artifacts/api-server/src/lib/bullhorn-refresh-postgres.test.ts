import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { runAppMigrations } from "@workspace/db/run-migrations";
import {
  claimReconnectNotice,
  claimRefreshAttempt,
  completeReconnectNotice,
  persistRefreshUncertain,
  persistDefinitiveInvalidGrant,
  persistRefreshTokenSuccess,
  supersedeWithReconnect,
} from "./bullhorn-refresh-coordinator.js";

function assertDedicatedDisposableDb(): void {
  if (process.env["ALLOW_BULLHORN_AUTH_SAFETY_DB_TESTS"] !== "1") {
    throw new Error("Set ALLOW_BULLHORN_AUTH_SAFETY_DB_TESTS=1 for disposable DB tests.");
  }
  const raw = process.env["DATABASE_URL"];
  if (!raw) throw new Error("DATABASE_URL is required for disposable DB tests.");
  const url = new URL(raw);
  const dbName = url.pathname.replace(/^\//, "");
  const hostParam = url.searchParams.get("host");
  const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const localSocket = Boolean(hostParam?.startsWith("/tmp/asktoact-auth-safety-"));
  if (!/^asktoact_auth_safety_test_[a-z0-9_]+$/.test(dbName)) {
    throw new Error(`Refusing non-dedicated database name: ${dbName}`);
  }
  if (!localHost && !localSocket) {
    throw new Error("Refusing non-local database host for auth safety DB tests.");
  }
}

async function resetRows(): Promise<void> {
  await pool.query("DELETE FROM bullhorn_tokens WHERE firm_id LIKE 'test_%'");
  await pool.query("DELETE FROM users WHERE id LIKE 'test_%'");
  await pool.query("DELETE FROM firms WHERE id LIKE 'test_%'");
}

async function seedFirm(firmId: string): Promise<void> {
  await pool.query("INSERT INTO firms (id, name) VALUES ($1, $2)", [firmId, firmId]);
}

async function seedFirmToken(firmId: string, refreshToken = "cipher-old"): Promise<void> {
  await seedFirm(firmId);
  await pool.query(
    `
      INSERT INTO bullhorn_tokens (
        id,
        firm_id,
        refresh_token,
        oauth_url,
        rest_url,
        login_url,
        auth_mode
      )
      VALUES ($1, $1, $2, 'https://oauth.example', 'https://rest.example', 'https://login.example', 'oauth')
    `,
    [firmId, refreshToken],
  );
}

async function seedUser(userId: string, firmId: string, refreshToken = "cipher-old"): Promise<void> {
  await seedFirm(firmId);
  await pool.query(
    `
      INSERT INTO users (
        id,
        name,
        email,
        api_key,
        firm_id,
        refresh_token
      )
      VALUES ($1, $1, $2, $3, $4, $5)
    `,
    [userId, `${userId}@example.com`, `${userId}-api-key`, firmId, refreshToken],
  );
}

beforeAll(async () => {
  assertDedicatedDisposableDb();
  const first = await runAppMigrations();
  const second = await runAppMigrations();
  expect(first.applied.includes("0022_bullhorn_refresh_generation") || first.skipped).toBe(true);
  expect(second).toEqual({ applied: [], skipped: true });
});

beforeEach(async () => {
  await resetRows();
});

describe("Bullhorn refresh coordinator on disposable PostgreSQL", () => {
  it("allows exactly one simultaneous claim for a firm generation", async () => {
    await seedFirmToken("test_firm_simultaneous");

    const results = await Promise.all([
      claimRefreshAttempt({
        kind: "firm",
        id: "test_firm_simultaneous",
        attemptId: "attempt-a",
        expectedGeneration: 0,
        expectedEncryptedRefreshToken: "cipher-old",
      }),
      claimRefreshAttempt({
        kind: "firm",
        id: "test_firm_simultaneous",
        attemptId: "attempt-b",
        expectedGeneration: 0,
        expectedEncryptedRefreshToken: "cipher-old",
      }),
    ]);

    expect(results.sort()).toEqual([false, true]);
    const { rows } = await pool.query(
      "SELECT refresh_outcome, refresh_attempt_id FROM bullhorn_tokens WHERE firm_id = $1",
      ["test_firm_simultaneous"],
    );
    expect(rows[0].refresh_outcome).toBe("claimed");
    expect(["attempt-a", "attempt-b"]).toContain(rows[0].refresh_attempt_id);
  });

  it("turns expired leases uncertain without authorizing a new redemption", async () => {
    await seedFirmToken("test_firm_expired");
    await pool.query(
      `
        UPDATE bullhorn_tokens
        SET refresh_outcome = 'claimed',
            refresh_attempt_id = 'old-attempt',
            refresh_lease_expires_at = now() - interval '1 minute'
        WHERE firm_id = 'test_firm_expired'
      `,
    );

    await expect(
      claimRefreshAttempt({
        kind: "firm",
        id: "test_firm_expired",
        attemptId: "new-attempt",
        expectedGeneration: 0,
        expectedEncryptedRefreshToken: "cipher-old",
      }),
    ).resolves.toBe(false);

    const { rows } = await pool.query(
      `
        SELECT refresh_outcome, refresh_attempt_id, refresh_lease_expires_at, refresh_uncertain_at,
               auth_healthy, last_auth_error
        FROM bullhorn_tokens
        WHERE firm_id = 'test_firm_expired'
      `,
    );
    expect(rows[0]).toMatchObject({
      refresh_outcome: "uncertain",
      refresh_attempt_id: "old-attempt",
      refresh_lease_expires_at: null,
      auth_healthy: false,
      last_auth_error: "refresh lease expired before completion",
    });
    expect(rows[0].refresh_uncertain_at).toBeInstanceOf(Date);
  });

  it("marks firm save uncertainty unhealthy without authorizing another redemption", async () => {
    await seedFirmToken("test_firm_uncertain");
    await expect(
      claimRefreshAttempt({
        kind: "firm",
        id: "test_firm_uncertain",
        attemptId: "attempt-uncertain",
        expectedGeneration: 0,
        expectedEncryptedRefreshToken: "cipher-old",
      }),
    ).resolves.toBe(true);

    await expect(
      persistRefreshUncertain({
        kind: "firm",
        id: "test_firm_uncertain",
        attemptId: "attempt-uncertain",
        expectedGeneration: 0,
        error: "token endpoint timed out; provider may still process refresh",
      }),
    ).resolves.toBe(true);
    await expect(
      claimRefreshAttempt({
        kind: "firm",
        id: "test_firm_uncertain",
        attemptId: "attempt-after-uncertain",
        expectedGeneration: 0,
        expectedEncryptedRefreshToken: "cipher-old",
      }),
    ).resolves.toBe(false);

    const { rows } = await pool.query(
      `
        SELECT refresh_outcome, refresh_attempt_id, refresh_uncertain_at,
               auth_healthy, last_auth_error
        FROM bullhorn_tokens
        WHERE firm_id = 'test_firm_uncertain'
      `,
    );
    expect(rows[0]).toMatchObject({
      refresh_outcome: "uncertain",
      refresh_attempt_id: "attempt-uncertain",
      auth_healthy: false,
      last_auth_error: "token endpoint timed out; provider may still process refresh",
    });
    expect(rows[0].refresh_uncertain_at).toBeInstanceOf(Date);
  });

  it("marks definitive firm invalid_grant unhealthy only for the matching generation", async () => {
    await seedFirmToken("test_firm_invalid_grant");
    await expect(
      claimRefreshAttempt({
        kind: "firm",
        id: "test_firm_invalid_grant",
        attemptId: "attempt-invalid",
        expectedGeneration: 0,
        expectedEncryptedRefreshToken: "cipher-old",
      }),
    ).resolves.toBe(true);

    await expect(
      persistDefinitiveInvalidGrant({
        kind: "firm",
        id: "test_firm_invalid_grant",
        attemptId: "attempt-invalid",
        expectedGeneration: 0,
        error: "invalid_grant",
      }),
    ).resolves.toBe(true);

    const { rows } = await pool.query(
      `
        SELECT refresh_outcome, auth_healthy, last_auth_error
        FROM bullhorn_tokens
        WHERE firm_id = 'test_firm_invalid_grant'
      `,
    );
    expect(rows[0]).toMatchObject({
      refresh_outcome: "needs_reauth",
      auth_healthy: false,
      last_auth_error: "invalid_grant",
    });

    await expect(
      persistDefinitiveInvalidGrant({
        kind: "firm",
        id: "test_firm_invalid_grant",
        attemptId: "attempt-invalid",
        expectedGeneration: 0,
        error: "late invalid_grant",
      }),
    ).resolves.toBe(false);
  });

  it("allows late success only for the original uncertain attempt/generation", async () => {
    await seedFirmToken("test_firm_late_success");
    await pool.query(
      `
        UPDATE bullhorn_tokens
        SET refresh_outcome = 'uncertain',
            refresh_attempt_id = 'old-attempt',
            refresh_uncertain_at = now()
        WHERE firm_id = 'test_firm_late_success'
      `,
    );

    await expect(
      persistRefreshTokenSuccess({
        kind: "firm",
        id: "test_firm_late_success",
        attemptId: "old-attempt",
        expectedGeneration: 0,
        expectedEncryptedRefreshToken: "cipher-old",
        replacementEncryptedRefreshToken: "cipher-new",
      }),
    ).resolves.toMatchObject({ saved: true, generation: 1 });

    const { rows } = await pool.query(
      `
        SELECT refresh_token, refresh_generation, refresh_outcome, refresh_attempt_id, refresh_uncertain_at
        FROM bullhorn_tokens
        WHERE firm_id = 'test_firm_late_success'
      `,
    );
    expect(rows[0]).toMatchObject({
      refresh_token: "cipher-new",
      refresh_generation: 1,
      refresh_outcome: "success",
      refresh_attempt_id: null,
      refresh_uncertain_at: null,
    });
  });

  it("fences refresh success and stale failures after reconnect supersedes work", async () => {
    await seedUser("test_user_reconnect", "test_firm_reconnect");
    await expect(
      claimRefreshAttempt({
        kind: "user",
        id: "test_user_reconnect",
        attemptId: "refresh-attempt",
        expectedGeneration: 0,
        expectedEncryptedRefreshToken: "cipher-old",
      }),
    ).resolves.toBe(true);

    await expect(
      supersedeWithReconnect({
        kind: "user",
        id: "test_user_reconnect",
        expectedGeneration: 0,
        encryptedRefreshToken: "cipher-reconnect",
        user: {
          bhRestToken: "bh-rest",
          restUrl: "https://rest.example",
          tokenExpiresAt: 1000,
          sessionExpiresAt: 2000,
        },
      }),
    ).resolves.toEqual({ saved: true, generation: 1 });

    await expect(
      persistRefreshTokenSuccess({
        kind: "user",
        id: "test_user_reconnect",
        attemptId: "refresh-attempt",
        expectedGeneration: 0,
        expectedEncryptedRefreshToken: "cipher-old",
        replacementEncryptedRefreshToken: "cipher-stale",
      }),
    ).resolves.toMatchObject({ saved: false });

    await expect(
      persistDefinitiveInvalidGrant({
        kind: "user",
        id: "test_user_reconnect",
        attemptId: "refresh-attempt",
        expectedGeneration: 0,
        error: "invalid_grant",
      }),
    ).resolves.toBe(false);

    const { rows } = await pool.query(
      `
        SELECT refresh_token, bullhorn_refresh_generation, bullhorn_refresh_outcome
        FROM users
        WHERE id = 'test_user_reconnect'
      `,
    );
    expect(rows[0]).toMatchObject({
      refresh_token: "cipher-reconnect",
      bullhorn_refresh_generation: 1,
      bullhorn_refresh_outcome: "success",
    });
  });

  it("rejects duplicate reconnects for the same old generation", async () => {
    await seedFirmToken("test_firm_duplicate_reconnect");

    await expect(
      supersedeWithReconnect({
        kind: "firm",
        id: "test_firm_duplicate_reconnect",
        expectedGeneration: 0,
        encryptedRefreshToken: "cipher-one",
        firm: {
          oauthUrl: "https://oauth.example",
          restUrl: "https://rest.example",
          loginUrl: "https://login.example",
          authMode: "oauth",
        },
      }),
    ).resolves.toEqual({ saved: true, generation: 1 });

    await expect(
      supersedeWithReconnect({
        kind: "firm",
        id: "test_firm_duplicate_reconnect",
        expectedGeneration: 0,
        encryptedRefreshToken: "cipher-two",
        firm: {
          oauthUrl: "https://oauth.example",
          restUrl: "https://rest.example",
          loginUrl: "https://login.example",
          authMode: "oauth",
        },
      }),
    ).resolves.toEqual({ saved: false, generation: 1 });
  });

  it("uses expected ciphertext and isolates firms/users", async () => {
    await seedFirmToken("test_firm_isolated_a", "same-cipher");
    await seedFirmToken("test_firm_isolated_b", "same-cipher");
    await seedUser("test_user_isolated", "test_firm_user_isolated", "same-cipher");

    await expect(
      claimRefreshAttempt({
        kind: "firm",
        id: "test_firm_isolated_a",
        attemptId: "wrong-cipher",
        expectedGeneration: 0,
        expectedEncryptedRefreshToken: "not-the-stored-ciphertext",
      }),
    ).resolves.toBe(false);

    await expect(
      claimRefreshAttempt({
        kind: "firm",
        id: "test_firm_isolated_a",
        attemptId: "firm-a",
        expectedGeneration: 0,
        expectedEncryptedRefreshToken: "same-cipher",
      }),
    ).resolves.toBe(true);

    await expect(
      claimRefreshAttempt({
        kind: "firm",
        id: "test_firm_isolated_b",
        attemptId: "firm-b",
        expectedGeneration: 0,
        expectedEncryptedRefreshToken: "same-cipher",
      }),
    ).resolves.toBe(true);

    await expect(
      claimRefreshAttempt({
        kind: "user",
        id: "test_user_isolated",
        attemptId: "user",
        expectedGeneration: 0,
        expectedEncryptedRefreshToken: "same-cipher",
      }),
    ).resolves.toBe(true);
  });

  it("recognizes an identical committed refresh-token save", async () => {
    await seedUser("test_user_identical", "test_firm_identical");
    await pool.query(
      `
        UPDATE users
        SET refresh_token = 'cipher-new',
            bullhorn_refresh_generation = 1,
            bullhorn_refresh_outcome = 'success',
            bullhorn_refresh_attempt_id = NULL
        WHERE id = 'test_user_identical'
      `,
    );

    await expect(
      persistRefreshTokenSuccess({
        kind: "user",
        id: "test_user_identical",
        attemptId: "attempt-that-already-committed",
        expectedGeneration: 0,
        expectedEncryptedRefreshToken: "cipher-old",
        replacementEncryptedRefreshToken: "cipher-new",
      }),
    ).resolves.toEqual({
      saved: true,
      generation: 1,
      identicalCommitted: true,
    });
  });

  it("claims and completes reconnect notices by affected rows", async () => {
    await seedUser("test_user_notice", "test_firm_notice");

    await expect(
      claimReconnectNotice({
        kind: "user",
        id: "test_user_notice",
        expectedGeneration: 0,
        attemptId: "notice-1",
      }),
    ).resolves.toBe(true);
    await expect(
      claimReconnectNotice({
        kind: "user",
        id: "test_user_notice",
        expectedGeneration: 0,
        attemptId: "notice-2",
      }),
    ).resolves.toBe(false);
    await expect(
      completeReconnectNotice({
        kind: "user",
        id: "test_user_notice",
        expectedGeneration: 0,
        attemptId: "notice-1",
        state: "accepted",
      }),
    ).resolves.toBe(true);
    await expect(
      claimReconnectNotice({
        kind: "user",
        id: "test_user_notice",
        expectedGeneration: 0,
        attemptId: "notice-3",
      }),
    ).resolves.toBe(false);
  });

  it("deduplicates firm notices and preserves accepted/failed/unknown terminal states", async () => {
    await seedFirmToken("test_firm_notice_states");

    await expect(
      claimReconnectNotice({
        kind: "firm",
        id: "test_firm_notice_states",
        expectedGeneration: 0,
        attemptId: "notice-accepted",
      }),
    ).resolves.toBe(true);
    await expect(
      claimReconnectNotice({
        kind: "firm",
        id: "test_firm_notice_states",
        expectedGeneration: 0,
        attemptId: "notice-duplicate",
      }),
    ).resolves.toBe(false);
    await expect(
      completeReconnectNotice({
        kind: "firm",
        id: "test_firm_notice_states",
        expectedGeneration: 0,
        attemptId: "notice-accepted",
        state: "accepted",
      }),
    ).resolves.toBe(true);
    await expect(
      claimReconnectNotice({
        kind: "firm",
        id: "test_firm_notice_states",
        expectedGeneration: 0,
        attemptId: "notice-after-accepted",
      }),
    ).resolves.toBe(false);

    await pool.query(
      `
        UPDATE bullhorn_tokens
        SET reconnect_notice_state = 'failed',
            reconnect_notice_attempt_id = NULL
        WHERE firm_id = 'test_firm_notice_states'
      `,
    );
    await expect(
      claimReconnectNotice({
        kind: "firm",
        id: "test_firm_notice_states",
        expectedGeneration: 0,
        attemptId: "notice-retry-failed",
      }),
    ).resolves.toBe(true);
    await expect(
      completeReconnectNotice({
        kind: "firm",
        id: "test_firm_notice_states",
        expectedGeneration: 0,
        attemptId: "notice-retry-failed",
        state: "unknown",
      }),
    ).resolves.toBe(true);
    await expect(
      claimReconnectNotice({
        kind: "firm",
        id: "test_firm_notice_states",
        expectedGeneration: 0,
        attemptId: "notice-after-unknown",
      }),
    ).resolves.toBe(false);
  });
});
