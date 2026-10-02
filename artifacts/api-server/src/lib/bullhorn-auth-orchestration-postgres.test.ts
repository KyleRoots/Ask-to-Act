import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { pool } from "@workspace/db";
import { runAppMigrations } from "@workspace/db/run-migrations";

const sendReconnectEmail = vi.fn();
const sendFirmAuthFailureAlert = vi.fn();

vi.mock("./emailService.js", () => ({
  sendReconnectEmail,
  sendFirmAuthFailureAlert,
}));

const {
  __bullhornAuthTestHooks,
  completeUserEnrollment,
  getSession,
  getUserSession,
} = await import("./bullhorn-auth.js");
const { maybeSendUserReconnectEmail } = await import("./user-reconnect-notify.js");
const { claimStateForExchange, consumeState, rememberState } = await import("./oauth-state.js");

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
    throw new Error("Refusing non-local database host for auth orchestration DB tests.");
  }
}

async function resetRows(): Promise<void> {
  await pool.query("DELETE FROM oauth_states WHERE state LIKE 'test-auth-orch-%'");
  await pool.query("DELETE FROM bullhorn_tokens WHERE firm_id LIKE 'test_auth_orch_%'");
  await pool.query("DELETE FROM users WHERE id LIKE 'test_auth_orch_%'");
  await pool.query("DELETE FROM firms WHERE id LIKE 'test_auth_orch_%'");
}

async function seedFirm(firmId: string): Promise<void> {
  await pool.query("INSERT INTO firms (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    firmId,
    firmId,
  ]);
}

async function seedFirmToken(opts: {
  firmId: string;
  refreshToken?: string;
  authMode?: "service" | "oauth";
}): Promise<void> {
  await seedFirm(opts.firmId);
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
      VALUES ($1, $1, $2, 'https://oauth.fake', 'https://rest.fake/rest-services/original', 'https://rest.fake/rest-services/login', $3)
    `,
    [opts.firmId, opts.refreshToken ?? "old-refresh", opts.authMode ?? "oauth"],
  );
}

async function seedUser(userId: string, firmId: string, refreshToken: string | null): Promise<void> {
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

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function bodyParams(init: RequestInit | undefined): URLSearchParams {
  return init?.body as URLSearchParams;
}

beforeAll(async () => {
  assertDedicatedDisposableDb();
  await runAppMigrations();
});

beforeEach(async () => {
  process.env["BULLHORN_CLIENT_ID"] = "client-id";
  process.env["BULLHORN_CLIENT_SECRET"] = "client-secret";
  process.env["BULLHORN_REDIRECT_URI"] = "https://connect.fake/callback";
  process.env["BULLHORN_USERNAME"] = "service-user";
  process.env["BULLHORN_PASSWORD"] = "service-pass";
  process.env["BASE_URL"] = "https://connect.fake";
  await resetRows();
  __bullhornAuthTestHooks.resetAuthState();
  sendReconnectEmail.mockReset();
  sendFirmAuthFailureAlert.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  __bullhornAuthTestHooks.resetAuthState();
});

describe("Bullhorn auth production orchestration safety", () => {
  it("does not clear credentials if a reconnect lands before invalid_grant reconnect URL minting", async () => {
    await seedFirmToken({ firmId: "test_auth_orch_firm_race" });
    await seedUser("test_auth_orch_user_race", "test_auth_orch_firm_race", "old-refresh");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://oauth.fake/token") {
          const body = bodyParams(init);
          if (body.get("grant_type") === "refresh_token") {
            return new Response("invalid_grant", { status: 400 });
          }
          if (body.get("code") === "fresh-code") {
            return json({
              access_token: "fresh-access",
              refresh_token: "fresh-refresh",
              expires_in: 600,
            });
          }
        }
        if (url.startsWith("https://rest.fake/rest-services/login")) {
          return json({
            BhRestToken: "fresh-bh-rest",
            restUrl: "https://rest.fake/rest-services/session",
          });
        }
        if (url.startsWith("https://rest.fake/rest-services/session/ping")) {
          return json({ sessionExpires: Date.now() + 600_000 });
        }
        throw new Error(`unexpected fake fetch: ${url}`);
      }),
    );

    __bullhornAuthTestHooks.setBeforeUserReconnectUrl(async ({ userId, expectedGeneration }) => {
      await completeUserEnrollment(userId, "fresh-code", expectedGeneration);
    });

    await expect(getUserSession("test_auth_orch_user_race")).rejects.toThrow(/superseded/i);

    const { rows } = await pool.query(
      `
        SELECT refresh_token, bullhorn_refresh_generation, enroll_token, bh_rest_token
        FROM users
        WHERE id = 'test_auth_orch_user_race'
      `,
    );
    expect(rows[0]).toMatchObject({
      refresh_token: "fresh-refresh",
      bullhorn_refresh_generation: 1,
      enroll_token: null,
      bh_rest_token: "fresh-bh-rest",
    });
  });

  it("recovers a service firm through headless direct login after refresh failure", async () => {
    await seedFirmToken({
      firmId: "test_auth_orch_service",
      refreshToken: "old-service-refresh",
      authMode: "service",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://oauth.fake/token") {
          const body = bodyParams(init);
          if (body.get("grant_type") === "refresh_token") {
            return new Response("invalid_grant", { status: 400 });
          }
          if (body.get("code") === "service-code") {
            return json({
              access_token: "service-access",
              refresh_token: "service-refresh-new",
              expires_in: 600,
            });
          }
        }
        if (url.startsWith("https://rest.bullhornstaffing.com/rest-services/loginInfo")) {
          return json({
            oauthUrl: "https://oauth.fake",
            restUrl: "https://rest.fake/rest-services",
          });
        }
        if (url.startsWith("https://oauth.fake/authorize")) {
          return new Response(null, {
            status: 302,
            headers: { Location: "https://connect.fake/callback?code=service-code" },
          });
        }
        if (url.startsWith("https://rest.fake/rest-services/login")) {
          return json({
            BhRestToken: "service-bh-rest",
            restUrl: "https://rest.fake/rest-services/session",
          });
        }
        if (url.startsWith("https://rest.fake/rest-services/session/ping")) {
          return json({ sessionExpires: Date.now() + 600_000 });
        }
        throw new Error(`unexpected fake fetch: ${url}`);
      }),
    );

    await expect(getSession("test_auth_orch_service")).resolves.toMatchObject({
      BhRestToken: "service-bh-rest",
      refreshToken: "service-refresh-new",
    });

    const { rows } = await pool.query(
      `
        SELECT refresh_token, refresh_generation, refresh_outcome, refresh_attempt_id,
               refresh_lease_expires_at, refresh_uncertain_at, auth_healthy
        FROM bullhorn_tokens
        WHERE firm_id = 'test_auth_orch_service'
      `,
    );
    expect(rows[0]).toMatchObject({
      refresh_token: "service-refresh-new",
      refresh_generation: 1,
      refresh_outcome: "success",
      refresh_attempt_id: null,
      refresh_lease_expires_at: null,
      refresh_uncertain_at: null,
      auth_healthy: true,
    });
  });

  it("marks oauth firm invalid_grant unhealthy and sends one generation-fenced support alert", async () => {
    await seedFirmToken({
      firmId: "test_auth_orch_firm_invalid_grant",
      refreshToken: "old-firm-refresh",
      authMode: "oauth",
    });
    sendFirmAuthFailureAlert.mockResolvedValueOnce(undefined);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "https://oauth.fake/token") {
          return new Response("invalid_grant", { status: 400 });
        }
        throw new Error(`unexpected fake fetch: ${url}`);
      }),
    );

    await expect(getSession("test_auth_orch_firm_invalid_grant")).rejects.toThrow(
      /Bullhorn connection needs to be refreshed/i,
    );
    expect(sendFirmAuthFailureAlert).toHaveBeenCalledTimes(1);
    expect(sendFirmAuthFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        firmId: "test_auth_orch_firm_invalid_grant",
        firmName: "test_auth_orch_firm_invalid_grant",
        errorMessage: expect.stringContaining("invalid_grant"),
      }),
    );

    const { rows } = await pool.query(
      `
        SELECT refresh_outcome, auth_healthy, reconnect_notice_state,
               reconnect_notice_error
        FROM bullhorn_tokens
        WHERE firm_id = 'test_auth_orch_firm_invalid_grant'
      `,
    );
    expect(rows[0]).toMatchObject({
      refresh_outcome: "needs_reauth",
      auth_healthy: false,
      reconnect_notice_state: "accepted",
      reconnect_notice_error: null,
    });
  });

  it("marks ambiguous oauth firm refresh unhealthy and records failed support alert delivery", async () => {
    await seedFirmToken({
      firmId: "test_auth_orch_firm_ambiguous",
      refreshToken: "old-firm-refresh",
      authMode: "oauth",
    });
    sendFirmAuthFailureAlert.mockRejectedValueOnce(new Error("support mail down"));

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "https://oauth.fake/token") {
          throw new Error("network timeout");
        }
        throw new Error(`unexpected fake fetch: ${url}`);
      }),
    );

    await expect(getSession("test_auth_orch_firm_ambiguous")).rejects.toThrow(
      /Bullhorn refresh token request failed ambiguously/i,
    );
    expect(sendFirmAuthFailureAlert).toHaveBeenCalledTimes(1);

    const { rows } = await pool.query(
      `
        SELECT refresh_outcome, refresh_attempt_id, refresh_uncertain_at,
               auth_healthy, last_auth_error, reconnect_notice_state,
               reconnect_notice_error
        FROM bullhorn_tokens
        WHERE firm_id = 'test_auth_orch_firm_ambiguous'
      `,
    );
    expect(rows[0]).toMatchObject({
      refresh_outcome: "uncertain",
      auth_healthy: false,
      last_auth_error: expect.stringContaining("failed ambiguously"),
      reconnect_notice_state: "failed",
      reconnect_notice_error: "support mail down",
    });
    expect(rows[0].refresh_attempt_id).toBeTruthy();
    expect(rows[0].refresh_uncertain_at).toBeInstanceOf(Date);
  });

  it("does not send a stale firm failure alert after reconnect advances generation", async () => {
    await seedFirmToken({
      firmId: "test_auth_orch_firm_stale_failure",
      refreshToken: "old-firm-refresh",
      authMode: "oauth",
    });
    await pool.query(
      `
        UPDATE bullhorn_tokens
        SET refresh_token = 'reconnected-refresh',
            refresh_generation = 1,
            refresh_outcome = 'success'
        WHERE firm_id = 'test_auth_orch_firm_stale_failure'
      `,
    );

    const { persistDefinitiveInvalidGrant } = await import("./bullhorn-refresh-coordinator.js");
    await expect(
      persistDefinitiveInvalidGrant({
        kind: "firm",
        id: "test_auth_orch_firm_stale_failure",
        attemptId: "old-attempt",
        expectedGeneration: 0,
        error: "invalid_grant",
      }),
    ).resolves.toBe(false);
    const { maybeSendFirmAuthFailureAlert } = await import("./firm-auth-failure-notify.js");
    await expect(
      maybeSendFirmAuthFailureAlert({
        firmId: "test_auth_orch_firm_stale_failure",
        expectedGeneration: 0,
        errorMessage: "invalid_grant",
      }),
    ).resolves.toMatchObject({ sent: false, skippedReason: "not_claimed" });
    expect(sendFirmAuthFailureAlert).not.toHaveBeenCalled();
  });

  it("persists callback refresh tokens before REST login and consumes claimed state atomically", async () => {
    await seedFirmToken({ firmId: "test_auth_orch_firm_login_fail" });
    await seedUser("test_auth_orch_user_login_fail", "test_auth_orch_firm_login_fail", null);
    const state = "test-auth-orch-user-login-fail";
    await rememberState(state, "test_auth_orch_firm_login_fail", 0);
    const claim = await claimStateForExchange(state);
    expect(claim).toBeTruthy();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://oauth.fake/token") {
          expect(bodyParams(init).get("code")).toBe("login-fail-code");
          return json({
            access_token: "login-fail-access",
            refresh_token: "login-fail-refresh",
            expires_in: 600,
          });
        }
        if (url.startsWith("https://rest.fake/rest-services/login")) {
          return new Response("login failed", { status: 500 });
        }
        throw new Error(`unexpected fake fetch: ${url}`);
      }),
    );

    await expect(
      completeUserEnrollment("test_auth_orch_user_login_fail", "login-fail-code", 0, {
        state,
        attemptId: claim!.attemptId,
      }),
    ).rejects.toThrow(/login failed/i);

    const { rows } = await pool.query(
      `
        SELECT refresh_token, bullhorn_refresh_generation, bh_rest_token
        FROM users
        WHERE id = 'test_auth_orch_user_login_fail'
      `,
    );
    expect(rows[0]).toMatchObject({
      refresh_token: "login-fail-refresh",
      bullhorn_refresh_generation: 1,
      bh_rest_token: null,
    });
    await expect(consumeState(state)).resolves.toBe(false);
  });

  it("completes user callback when claimed firm still matches membership", async () => {
    await seedFirmToken({ firmId: "test_auth_orch_firm_match" });
    await seedUser("test_auth_orch_user_match", "test_auth_orch_firm_match", null);
    const state = "test-auth-orch-user-firm-match";
    await rememberState(state, "test_auth_orch_firm_match", 0);
    const claim = await claimStateForExchange(state);
    expect(claim).toMatchObject({
      firmId: "test_auth_orch_firm_match",
      expectedGeneration: 0,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://oauth.fake/token") {
          expect(bodyParams(init).get("code")).toBe("matching-code");
          return json({
            access_token: "matching-access",
            refresh_token: "matching-refresh",
            expires_in: 600,
          });
        }
        if (url.startsWith("https://rest.fake/rest-services/login")) {
          return json({
            BhRestToken: "matching-bh-rest",
            restUrl: "https://rest.fake/rest-services/session",
          });
        }
        if (url.startsWith("https://rest.fake/rest-services/session/ping")) {
          return json({ sessionExpires: Date.now() + 600_000 });
        }
        throw new Error(`unexpected fake fetch: ${url}`);
      }),
    );

    await completeUserEnrollment("test_auth_orch_user_match", "matching-code", 0, {
      state,
      attemptId: claim!.attemptId,
      expectedFirmId: claim!.firmId,
    });

    const { rows } = await pool.query(
      `
        SELECT firm_id, refresh_token, bullhorn_refresh_generation, bh_rest_token
        FROM users
        WHERE id = 'test_auth_orch_user_match'
      `,
    );
    expect(rows[0]).toMatchObject({
      firm_id: "test_auth_orch_firm_match",
      refresh_token: "matching-refresh",
      bullhorn_refresh_generation: 1,
      bh_rest_token: "matching-bh-rest",
    });
    await expect(consumeState(state)).resolves.toBe(false);
  });

  it("rejects user callback before provider exchange when firm membership changed without generation change", async () => {
    await seedFirmToken({ firmId: "test_auth_orch_firm_a" });
    await seedFirmToken({ firmId: "test_auth_orch_firm_b" });
    await seedUser("test_auth_orch_user_moved", "test_auth_orch_firm_a", null);
    const state = "test-auth-orch-user-firm-moved";
    await rememberState(state, "test_auth_orch_firm_a", 0);
    const claim = await claimStateForExchange(state);
    expect(claim?.firmId).toBe("test_auth_orch_firm_a");
    await pool.query(
      "UPDATE users SET firm_id = 'test_auth_orch_firm_b' WHERE id = 'test_auth_orch_user_moved'",
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeUserEnrollment("test_auth_orch_user_moved", "moved-code", 0, {
        state,
        attemptId: claim!.attemptId,
        expectedFirmId: claim!.firmId,
      }),
    ).rejects.toThrow(/stale for this firm membership/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rechecks user firm membership during atomic callback token save", async () => {
    await seedFirmToken({ firmId: "test_auth_orch_firm_save_a" });
    await seedFirmToken({ firmId: "test_auth_orch_firm_save_b" });
    await seedUser("test_auth_orch_user_save_race", "test_auth_orch_firm_save_a", "old-refresh");
    const state = "test-auth-orch-user-firm-save-race";
    await rememberState(state, "test_auth_orch_firm_save_a", 0);
    const claim = await claimStateForExchange(state);
    expect(claim?.firmId).toBe("test_auth_orch_firm_save_a");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "https://oauth.fake/token") {
          await pool.query(
            "UPDATE users SET firm_id = 'test_auth_orch_firm_save_b' WHERE id = 'test_auth_orch_user_save_race'",
          );
          return json({
            access_token: "save-race-access",
            refresh_token: "save-race-refresh",
            expires_in: 600,
          });
        }
        throw new Error(`unexpected fake fetch: ${url}`);
      }),
    );

    await expect(
      completeUserEnrollment("test_auth_orch_user_save_race", "save-race-code", 0, {
        state,
        attemptId: claim!.attemptId,
        expectedFirmId: claim!.firmId,
      }),
    ).rejects.toThrow(/superseded before token persistence/i);

    const { rows } = await pool.query(
      `
        SELECT firm_id, refresh_token, bullhorn_refresh_generation
        FROM users
        WHERE id = 'test_auth_orch_user_save_race'
      `,
    );
    expect(rows[0]).toMatchObject({
      firm_id: "test_auth_orch_firm_save_b",
      refresh_token: "old-refresh",
      bullhorn_refresh_generation: 0,
    });
    const stateRows = await pool.query(
      "SELECT claim_attempt_id FROM oauth_states WHERE state = $1",
      [state],
    );
    expect(stateRows.rowCount).toBe(1);
  });

  it("rejects stale user callbacks before provider exchange", async () => {
    await seedFirmToken({ firmId: "test_auth_orch_firm_stale" });
    await seedUser("test_auth_orch_user_stale", "test_auth_orch_firm_stale", "current-refresh");
    await pool.query(
      "UPDATE users SET bullhorn_refresh_generation = 1 WHERE id = 'test_auth_orch_user_stale'",
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeUserEnrollment("test_auth_orch_user_stale", "stale-code", 0),
    ).rejects.toThrow(/stale/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a new-generation failure notice after accepted notice then reconnect", async () => {
    await seedFirmToken({ firmId: "test_auth_orch_firm_notice" });
    await seedUser("test_auth_orch_user_notice", "test_auth_orch_firm_notice", "old-refresh");

    sendReconnectEmail.mockResolvedValueOnce(undefined);
    await expect(
      maybeSendUserReconnectEmail({
        userId: "test_auth_orch_user_notice",
        connectUrl: "https://connect.fake/reconnect",
        expectedGeneration: 0,
        nowMs: Date.parse("2026-10-02T00:00:00Z"),
      }),
    ).resolves.toMatchObject({ sent: true, state: "accepted" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://oauth.fake/token") {
          expect(bodyParams(init).get("code")).toBe("notice-reconnect-code");
          return json({
            access_token: "notice-access",
            refresh_token: "notice-refresh-new",
            expires_in: 600,
          });
        }
        if (url.startsWith("https://rest.fake/rest-services/login")) {
          return json({
            BhRestToken: "notice-bh-rest",
            restUrl: "https://rest.fake/rest-services/session",
          });
        }
        if (url.startsWith("https://rest.fake/rest-services/session/ping")) {
          return json({ sessionExpires: Date.now() + 600_000 });
        }
        throw new Error(`unexpected fake fetch: ${url}`);
      }),
    );
    await completeUserEnrollment("test_auth_orch_user_notice", "notice-reconnect-code", 0);

    sendReconnectEmail.mockRejectedValueOnce(new Error("mailer down"));
    await expect(
      maybeSendUserReconnectEmail({
        userId: "test_auth_orch_user_notice",
        connectUrl: "https://connect.fake/reconnect-again",
        expectedGeneration: 1,
        nowMs: Date.parse("2026-10-03T01:00:00Z"),
      }),
    ).resolves.toMatchObject({ sent: false, skippedReason: "send_failed" });

    const { rows } = await pool.query(
      `
        SELECT bullhorn_refresh_generation, bullhorn_reconnect_notice_state,
               bullhorn_reconnect_notice_error
        FROM users
        WHERE id = 'test_auth_orch_user_notice'
      `,
    );
    expect(rows[0]).toMatchObject({
      bullhorn_refresh_generation: 1,
      bullhorn_reconnect_notice_state: "failed",
      bullhorn_reconnect_notice_error: "mailer down",
    });
  });
});
