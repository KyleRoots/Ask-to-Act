import { randomBytes } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "@workspace/db";
import { runAppMigrations } from "@workspace/db/run-migrations";
import express from "express";
import request from "supertest";
import { BullhornDataCenterUnknownError, BullhornOAuthAppMissingError } from "./bullhorn-oauth-app.js";
import { logger } from "./logger.js";
import { decryptToken, encryptToken } from "./token-crypto.js";
import usersRouter from "../routes/users.js";

const {
  __bullhornAuthTestHooks,
  BullhornFirmNotConnectedError,
  BullhornUserDataCenterMismatchError,
  completeUserEnrollment,
  enrollUserHeadless,
  getUserSession,
  invalidateUserSession,
} = await import("./bullhorn-auth.js");

const LOGIN_INFO = "https://rest.bullhornstaffing.com/rest-services/loginInfo";
const ENV_KEYS = [
  "TOKEN_ENCRYPTION_KEY",
  "BULLHORN_CLIENT_ID",
  "BULLHORN_CLIENT_SECRET",
  "BULLHORN_REDIRECT_URI",
  "BULLHORN_USERNAME",
  "BULLHORN_PASSWORD",
  "BASE_URL",
] as const;

const FIRM_CLIENT_ID = "firm-client-id";
const FIRM_CLIENT_SECRET = "firm-client-secret";
const RECRUITER_PASSWORD = "recruiter password";
const PLATFORM_PASSWORD = "platform-user-password";

let previousEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const logLines: string[] = [];

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

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function redirect(code: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: `https://connect.fake/callback?code=${code}` },
  });
}

function bodyParams(init: RequestInit | undefined): URLSearchParams {
  return init?.body as URLSearchParams;
}

function assertSecretAbsent(haystack: string, secret: string): void {
  expect(haystack).not.toContain(secret);
  const encoded = encodeURIComponent(secret);
  if (encoded !== secret) expect(haystack).not.toContain(encoded);
  const formEncoded = new URLSearchParams({ password: secret })
    .toString()
    .slice("password=".length);
  if (formEncoded !== secret) expect(haystack).not.toContain(formEncoded);
}

async function resetRows(): Promise<void> {
  await pool.query("DELETE FROM bullhorn_tokens WHERE firm_id LIKE 'test_user_firm_%'");
  await pool.query("DELETE FROM users WHERE id LIKE 'test_user_firm_%'");
  await pool.query("DELETE FROM firms WHERE id LIKE 'test_user_firm_%'");
}

async function seedFirm(firmId: string): Promise<void> {
  await pool.query("INSERT INTO firms (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    firmId,
    firmId,
  ]);
}

async function seedFirmToken(opts: {
  firmId: string;
  oauthUrl?: string | null;
  loginUrl?: string | null;
  oauthClientId?: string | null;
  oauthClientSecret?: string | null;
  usesPlatformClient?: boolean;
  refreshToken?: string;
}): Promise<void> {
  await seedFirm(opts.firmId);
  await pool.query(
    `
      INSERT INTO bullhorn_tokens (
        id, firm_id, refresh_token, oauth_url, rest_url, login_url, auth_mode,
        oauth_client_id, oauth_client_secret, uses_platform_client
      )
      VALUES ($1, $1, $2, $3, NULL, $4, 'oauth', $5, $6, $7)
    `,
    [
      opts.firmId,
      opts.refreshToken ?? "firm-refresh-not-used",
      opts.oauthUrl ?? null,
      opts.loginUrl ?? null,
      opts.oauthClientId ?? null,
      opts.oauthClientSecret ?? null,
      opts.usesPlatformClient ?? false,
    ],
  );
}

async function seedUser(
  userId: string,
  firmId: string,
  refreshToken: string | null,
): Promise<void> {
  await pool.query(
    `
      INSERT INTO users (id, name, email, api_key, firm_id, refresh_token)
      VALUES ($1, $1, $2, $3, $4, $5)
    `,
    [userId, `${userId}@example.com`, `${userId}-api-key`, firmId, refreshToken],
  );
}

async function dumpFirmAndUsers(firmId: string): Promise<string> {
  const firm = await pool.query(
    `
      SELECT oauth_url, login_url, rest_url, refresh_token, oauth_client_id,
             oauth_client_secret, last_auth_error, auth_mode, uses_platform_client
      FROM bullhorn_tokens WHERE firm_id = $1
    `,
    [firmId],
  );
  const users = await pool.query(
    `
      SELECT id, refresh_token, bh_rest_token, rest_url, bullhorn_refresh_outcome,
             bullhorn_reconnect_notice_error
      FROM users WHERE firm_id = $1
    `,
    [firmId],
  );
  return JSON.stringify({ firm: firm.rows, users: users.rows });
}

function storedClient(): { id: string; secret: string } {
  return {
    id: encryptToken(FIRM_CLIENT_ID),
    secret: encryptToken(FIRM_CLIENT_SECRET),
  };
}

beforeAll(async () => {
  assertDedicatedDisposableDb();
  await runAppMigrations();
});

beforeEach(async () => {
  previousEnv = {};
  for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
  process.env["TOKEN_ENCRYPTION_KEY"] = randomBytes(32).toString("base64");
  process.env["BULLHORN_CLIENT_ID"] = "client-id";
  process.env["BULLHORN_CLIENT_SECRET"] = "client-secret";
  process.env["BULLHORN_REDIRECT_URI"] = "https://connect.fake/callback";
  process.env["BULLHORN_USERNAME"] = "service-user";
  process.env["BULLHORN_PASSWORD"] = "service-pass";
  process.env["BASE_URL"] = "https://connect.fake";
  logLines.length = 0;
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      logLines.push(JSON.stringify(args));
      return undefined as never;
    });
  }
  await resetRows();
  __bullhornAuthTestHooks.resetAuthState();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __bullhornAuthTestHooks.resetAuthState();
});

describe("recruiter enrollment uses the firm's Bullhorn client", () => {
  it("enrolls when loginInfo REST host differs from the stored swimlane but the OAuth host matches", async () => {
    const client = storedClient();
    await seedFirmToken({
      firmId: "test_user_firm_qualified",
      oauthUrl: "https://auth-east.example/oauth",
      loginUrl: "https://rest45.example/rest-services/login",
      oauthClientId: client.id,
      oauthClientSecret: client.secret,
      usesPlatformClient: false,
    });
    await seedUser("test_user_firm_qualified_user", "test_user_firm_qualified", null);
    await seedUser("test_user_firm_qualified_browser", "test_user_firm_qualified", null);

    const loginInfoUsernames: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith(LOGIN_INFO)) {
          const username = new URL(url).searchParams.get("username");
          loginInfoUsernames.push(username);
          if (username === "qualified.recruiter") {
            // Same OAuth host as the firm, different REST host. Bullhorn
            // returns rest-east from loginInfo and rest45 as the session
            // login URL for one East data center.
            return json({
              oauthUrl: "https://auth-east.example/oauth",
              restUrl: "https://rest-east.example/rest-services",
              dataCenterId: 4,
            });
          }
          if (username === "service-user") {
            return json({
              oauthUrl: "https://oauth.service.example/oauth",
              restUrl: "https://rest.service.example/rest-services/svc",
            });
          }
          throw new Error(`unexpected loginInfo username: ${username}`);
        }
        if (url.includes("/authorize")) {
          const parsed = new URL(url);
          const clientId = parsed.searchParams.get("client_id");
          if (clientId === FIRM_CLIENT_ID) {
            expect(parsed.origin + parsed.pathname).toBe(
              "https://auth-east.example/oauth/authorize",
            );
            expect(parsed.searchParams.get("username")).toBe("qualified.recruiter");
            expect(parsed.searchParams.get("password")).toBe(RECRUITER_PASSWORD);
            return redirect("qualified-code");
          }
          expect(clientId).toBe("client-id");
          expect(parsed.origin + parsed.pathname).toBe(
            "https://oauth.service.example/oauth/authorize",
          );
          expect(parsed.searchParams.get("username")).toBe("service-user");
          expect(parsed.searchParams.get("password")).toBe("service-pass");
          return redirect("service-code");
        }
        if (url.endsWith("/token")) {
          expect(url).toBe("https://auth-east.example/oauth/token");
          const body = bodyParams(init);
          expect(body.get("client_id")).toBe(FIRM_CLIENT_ID);
          expect(body.get("client_secret")).toBe(FIRM_CLIENT_SECRET);
          if (body.get("grant_type") === "authorization_code" && body.get("code") === "qualified-code") {
            return json({
              access_token: "qualified-access",
              refresh_token: "qualified-user-refresh",
              expires_in: 600,
            });
          }
          if (body.get("grant_type") === "authorization_code" && body.get("code") === "browser-code") {
            return json({
              access_token: "browser-access",
              refresh_token: "browser-user-refresh",
              expires_in: 600,
            });
          }
          if (body.get("grant_type") === "refresh_token") {
            expect(body.get("refresh_token")).toBe("qualified-user-refresh");
            return json({
              access_token: "qualified-access-2",
              refresh_token: "qualified-user-refresh-2",
              expires_in: 600,
            });
          }
        }
        if (url.startsWith("https://rest45.example/rest-services/login")) {
          return json({
            BhRestToken: "qualified-bh-rest",
            restUrl: "https://rest45.example/rest-services/session",
          });
        }
        if (url.includes("/ping")) {
          return json({ sessionExpires: Date.now() + 600_000 });
        }
        throw new Error(`unexpected fake fetch: ${url}`);
      }),
    );

    await enrollUserHeadless(
      "test_user_firm_qualified_user",
      "qualified.recruiter",
      RECRUITER_PASSWORD,
    );
    expect(loginInfoUsernames).toEqual(["qualified.recruiter"]);

    await completeUserEnrollment("test_user_firm_qualified_browser", "browser-code");
    expect(loginInfoUsernames).toEqual(["qualified.recruiter"]);

    invalidateUserSession("test_user_firm_qualified_user");
    await expect(getUserSession("test_user_firm_qualified_user")).resolves.toMatchObject({
      BhRestToken: "qualified-bh-rest",
      restUrl: "https://rest45.example/rest-services/session",
    });
    expect(loginInfoUsernames).toEqual(["qualified.recruiter"]);

    const serviceCode = await __bullhornAuthTestHooks.serviceHeadlessAuthCode();
    expect(serviceCode).toMatchObject({
      oauthUrl: "https://oauth.service.example/oauth",
      code: "service-code",
    });
    expect(loginInfoUsernames).toEqual(["qualified.recruiter", "service-user"]);
    expect(__bullhornAuthTestHooks.isDirectLoginCoolingDown()).toBe(false);

    const { rows } = await pool.query(
      `
        SELECT id, refresh_token, bh_rest_token
        FROM users WHERE firm_id = 'test_user_firm_qualified' ORDER BY id
      `,
    );
    expect(rows.map((row) => row.id)).toEqual([
      "test_user_firm_qualified_browser",
      "test_user_firm_qualified_user",
    ]);
    expect(decryptToken(rows[0].refresh_token)).toBe("browser-user-refresh");
    expect(decryptToken(rows[1].refresh_token)).toBe("qualified-user-refresh-2");
    expect(rows[1].bh_rest_token).toBe("qualified-bh-rest");

    const firm = await pool.query(
      `
        SELECT oauth_url, login_url, refresh_token, uses_platform_client, auth_mode
        FROM bullhorn_tokens WHERE firm_id = 'test_user_firm_qualified'
      `,
    );
    expect(firm.rows[0]).toMatchObject({
      oauth_url: "https://auth-east.example/oauth",
      login_url: "https://rest45.example/rest-services/login",
      refresh_token: "firm-refresh-not-used",
      uses_platform_client: false,
      auth_mode: "oauth",
    });

    const dumped = await dumpFirmAndUsers("test_user_firm_qualified");
    assertSecretAbsent(dumped, RECRUITER_PASSWORD);
    assertSecretAbsent(logLines.join("\n"), RECRUITER_PASSWORD);
  });

  it("keeps a platform-client user on the env client and refuses an unconnected customer firm", async () => {
    const client = storedClient();
    await seedFirmToken({
      firmId: "test_user_firm_platform",
      usesPlatformClient: true,
    });
    await seedFirmToken({
      firmId: "test_user_firm_swimlane",
      oauthClientId: client.id,
      oauthClientSecret: client.secret,
      usesPlatformClient: false,
    });
    await seedUser(
      "test_user_firm_platform_user",
      "test_user_firm_platform",
      null,
    );
    await seedUser(
      "test_user_firm_swimlane_user",
      "test_user_firm_swimlane",
      "pre-enroll-refresh",
    );

    const earlyFetch = vi.fn();
    vi.stubGlobal("fetch", earlyFetch);
    await expect(getUserSession("test_user_firm_swimlane_user")).rejects.toBeInstanceOf(
      BullhornDataCenterUnknownError,
    );
    expect(earlyFetch).not.toHaveBeenCalled();
    const before = await pool.query(
      `
        SELECT refresh_token, bullhorn_refresh_generation, bullhorn_refresh_outcome
        FROM users WHERE id = 'test_user_firm_swimlane_user'
      `,
    );
    expect(before.rows[0]).toMatchObject({
      refresh_token: "pre-enroll-refresh",
      bullhorn_refresh_generation: 0,
      bullhorn_refresh_outcome: "idle",
    });

    const loginInfoUsernames: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith(LOGIN_INFO)) {
          const username = new URL(url).searchParams.get("username");
          loginInfoUsernames.push(username);
          if (username === "service-user") {
            return json({
              oauthUrl: "https://oauth.platform.example/oauth",
              restUrl: "https://rest.platform.example/rest-services/svc",
            });
          }
          throw new Error(`unexpected loginInfo username: ${username}`);
        }
        if (url.includes("/authorize")) {
          const parsed = new URL(url);
          expect(parsed.origin).toBe("https://oauth.platform.example");
          expect(parsed.searchParams.get("client_id")).toBe("client-id");
          expect(parsed.searchParams.get("username")).toBe("myticas.recruiter");
          expect(parsed.searchParams.get("password")).toBe(PLATFORM_PASSWORD);
          return redirect("platform-code");
        }
        if (url.endsWith("/token")) {
          expect(url).toBe("https://oauth.platform.example/oauth/token");
          const body = bodyParams(init);
          expect(body.get("client_id")).toBe("client-id");
          expect(body.get("client_secret")).toBe("client-secret");
          return json({
            access_token: "platform-access",
            refresh_token: "platform-user-refresh",
            expires_in: 600,
          });
        }
        if (url.startsWith("https://rest.platform.example/rest-services/svc/login")) {
          return json({
            BhRestToken: "platform-bh-rest",
            restUrl: "https://rest.platform.example/rest-services/session",
          });
        }
        if (url.includes("/ping")) {
          return json({ sessionExpires: Date.now() + 600_000 });
        }
        throw new Error(`unexpected fake fetch: ${url}`);
      }),
    );

    await enrollUserHeadless(
      "test_user_firm_platform_user",
      "myticas.recruiter",
      PLATFORM_PASSWORD,
    );
    expect(loginInfoUsernames).toEqual(["service-user"]);
    const platformFirm = await pool.query(
      `
        SELECT oauth_url, login_url, uses_platform_client
        FROM bullhorn_tokens WHERE firm_id = 'test_user_firm_platform'
      `,
    );
    expect(platformFirm.rows[0]).toMatchObject({
      oauth_url: null,
      login_url: null,
      uses_platform_client: true,
    });

    await expect(
      enrollUserHeadless(
        "test_user_firm_swimlane_user",
        "qualified.recruiter",
        RECRUITER_PASSWORD,
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/ask your administrator to connect the firm first/i),
    });
    expect(loginInfoUsernames).toEqual(["service-user"]);
    const swimlaneFirm = await pool.query(
      `
        SELECT oauth_url, login_url, refresh_token, auth_mode, uses_platform_client
        FROM bullhorn_tokens WHERE firm_id = 'test_user_firm_swimlane'
      `,
    );
    expect(swimlaneFirm.rows[0]).toMatchObject({
      oauth_url: null,
      login_url: null,
      refresh_token: "firm-refresh-not-used",
      auth_mode: "oauth",
      uses_platform_client: false,
    });
    const swimlaneUser = await pool.query(
      `
        SELECT refresh_token, bullhorn_refresh_generation
        FROM users WHERE id = 'test_user_firm_swimlane_user'
      `,
    );
    expect(swimlaneUser.rows[0]).toMatchObject({
      refresh_token: "pre-enroll-refresh",
      bullhorn_refresh_generation: 0,
    });

    const dumped = [
      await dumpFirmAndUsers("test_user_firm_platform"),
      await dumpFirmAndUsers("test_user_firm_swimlane"),
    ].join("\n");
    assertSecretAbsent(dumped, RECRUITER_PASSWORD);
    assertSecretAbsent(dumped, PLATFORM_PASSWORD);
    assertSecretAbsent(logLines.join("\n"), RECRUITER_PASSWORD);
    assertSecretAbsent(logLines.join("\n"), PLATFORM_PASSWORD);
    expect(__bullhornAuthTestHooks.isDirectLoginCoolingDown()).toBe(false);
  });

  it("keeps a platform-client user on the env client and the firm's stored swimlane", async () => {
    await seedFirmToken({
      firmId: "test_user_firm_myticas",
      oauthUrl: "https://oauth.platform.example/oauth",
      loginUrl: "https://rest.platform.example/rest-services/login",
      usesPlatformClient: true,
    });
    await seedUser("test_user_firm_myticas_user", "test_user_firm_myticas", null);
    const loginInfoUsernames: Array<string | null> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith(LOGIN_INFO)) {
          loginInfoUsernames.push(new URL(url).searchParams.get("username"));
          throw new Error("platform user with a stored swimlane must not call loginInfo");
        }
        if (url.includes("/authorize")) {
          const parsed = new URL(url);
          expect(parsed.origin + parsed.pathname).toBe(
            "https://oauth.platform.example/oauth/authorize",
          );
          expect(parsed.searchParams.get("client_id")).toBe("client-id");
          expect(parsed.searchParams.get("username")).toBe("myticas.recruiter");
          expect(parsed.searchParams.get("password")).toBe(PLATFORM_PASSWORD);
          return redirect("myticas-code");
        }
        if (url.endsWith("/token")) {
          expect(url).toBe("https://oauth.platform.example/oauth/token");
          const body = bodyParams(init);
          expect(body.get("client_id")).toBe("client-id");
          expect(body.get("client_secret")).toBe("client-secret");
          if (body.get("grant_type") === "refresh_token") {
            expect(body.get("refresh_token")).toBe("myticas-user-refresh");
            return json({
              access_token: "myticas-access-2",
              refresh_token: "myticas-user-refresh-2",
              expires_in: 600,
            });
          }
          return json({
            access_token: "myticas-access",
            refresh_token: "myticas-user-refresh",
            expires_in: 600,
          });
        }
        if (url.startsWith("https://rest.platform.example/rest-services/login")) {
          return json({
            BhRestToken: "myticas-bh-rest",
            restUrl: "https://rest.platform.example/rest-services/session",
          });
        }
        if (url.includes("/ping")) {
          return json({ sessionExpires: Date.now() + 600_000 });
        }
        throw new Error(`unexpected fake fetch: ${url}`);
      }),
    );

    await enrollUserHeadless(
      "test_user_firm_myticas_user",
      "myticas.recruiter",
      PLATFORM_PASSWORD,
    );
    invalidateUserSession("test_user_firm_myticas_user");
    await expect(getUserSession("test_user_firm_myticas_user")).resolves.toMatchObject({
      BhRestToken: "myticas-bh-rest",
      restUrl: "https://rest.platform.example/rest-services/session",
    });
    expect(loginInfoUsernames).toEqual([]);
    const dumped = await dumpFirmAndUsers("test_user_firm_myticas");
    assertSecretAbsent(dumped, PLATFORM_PASSWORD);
    assertSecretAbsent(logLines.join("\n"), PLATFORM_PASSWORD);
  });

  it("refuses a recruiter whose OAuth host is a different data center and leaves the firm row unchanged", async () => {
    const client = storedClient();
    await seedFirmToken({
      firmId: "test_user_firm_mismatch",
      oauthUrl: "https://auth-east.example/oauth",
      loginUrl: "https://rest45.example/rest-services/login",
      oauthClientId: client.id,
      oauthClientSecret: client.secret,
    });
    await seedUser("test_user_firm_mismatch_user", "test_user_firm_mismatch", null);
    await pool.query(
      `
        UPDATE users
        SET enroll_token = 'test_user_firm_mismatch_token',
            enroll_token_expires_at = now() + interval '1 day'
        WHERE id = 'test_user_firm_mismatch_user'
      `,
    );
    const before = await pool.query(
      `
        SELECT oauth_url, login_url, refresh_token, auth_mode, uses_platform_client, updated_at
        FROM bullhorn_tokens WHERE firm_id = 'test_user_firm_mismatch'
      `,
    );
    const authorizeCalls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith(LOGIN_INFO)) {
          expect(new URL(url).searchParams.get("username")).toBe("other.datacenter");
          return json({
            oauthUrl: "https://auth-west.example/oauth",
            restUrl: "https://rest99.example/rest-services",
          });
        }
        if (url.includes("/authorize")) authorizeCalls.push(url);
        throw new Error(`unexpected fake fetch: ${url}`);
      }),
    );

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use("/api", usersRouter);
    const res = await request(app)
      .post("/api/auth/user/enroll")
      .type("form")
      .send({
        token: "test_user_firm_mismatch_token",
        bhUsername: "other.datacenter",
        bhPassword: RECRUITER_PASSWORD,
      });

    expect(res.status).toBe(409);
    expect(res.text).toMatch(/different data center than your firm/i);
    assertSecretAbsent(res.text, RECRUITER_PASSWORD);
    expect(authorizeCalls).toEqual([]);
    const after = await pool.query(
      `
        SELECT oauth_url, login_url, refresh_token, auth_mode, uses_platform_client, updated_at
        FROM bullhorn_tokens WHERE firm_id = 'test_user_firm_mismatch'
      `,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    const user = await pool.query(
      `
        SELECT refresh_token, enroll_token, bullhorn_refresh_generation
        FROM users WHERE id = 'test_user_firm_mismatch_user'
      `,
    );
    expect(user.rows[0]).toMatchObject({
      refresh_token: null,
      enroll_token: "test_user_firm_mismatch_token",
      bullhorn_refresh_generation: 0,
    });
    assertSecretAbsent(logLines.join("\n"), RECRUITER_PASSWORD);
  });

  it("leaves the firm row unchanged when authorize fails after a matching data center", async () => {
    const client = storedClient();
    await seedFirmToken({
      firmId: "test_user_firm_authfail",
      oauthUrl: "https://auth-east.example/oauth",
      loginUrl: "https://rest45.example/rest-services/login",
      oauthClientId: client.id,
      oauthClientSecret: client.secret,
    });
    await seedUser("test_user_firm_authfail_user", "test_user_firm_authfail", null);
    const before = await pool.query(
      `
        SELECT oauth_url, login_url, refresh_token, auth_mode, uses_platform_client, updated_at
        FROM bullhorn_tokens WHERE firm_id = 'test_user_firm_authfail'
      `,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith(LOGIN_INFO)) {
          return json({
            oauthUrl: "https://auth-east.example/oauth",
            restUrl: "https://rest45.example/rest-services",
          });
        }
        if (url.includes("/authorize")) {
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://connect.fake/callback?error=access_denied&error_description=bad",
            },
          });
        }
        throw new Error(`unexpected fake fetch: ${url}`);
      }),
    );

    await expect(
      enrollUserHeadless(
        "test_user_firm_authfail_user",
        "qualified.recruiter",
        RECRUITER_PASSWORD,
      ),
    ).rejects.toThrow(/authorization returned an error/i);
    const after = await pool.query(
      `
        SELECT oauth_url, login_url, refresh_token, auth_mode, uses_platform_client, updated_at
        FROM bullhorn_tokens WHERE firm_id = 'test_user_firm_authfail'
      `,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    const user = await pool.query(
      `
        SELECT refresh_token, bullhorn_refresh_generation
        FROM users WHERE id = 'test_user_firm_authfail_user'
      `,
    );
    expect(user.rows[0]).toMatchObject({
      refresh_token: null,
      bullhorn_refresh_generation: 0,
    });
  });

  it("fails closed when a customer firm has no stored client", async () => {
    await seedFirmToken({
      firmId: "test_user_firm_noclient",
      oauthUrl: "https://auth-east.example/oauth",
      loginUrl: "https://rest45.example/rest-services/login",
      usesPlatformClient: false,
    });
    await seedUser(
      "test_user_firm_noclient_user",
      "test_user_firm_noclient",
      "kept-refresh",
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      enrollUserHeadless(
        "test_user_firm_noclient_user",
        "qualified.recruiter",
        RECRUITER_PASSWORD,
      ),
    ).rejects.toThrow(/not stored for this firm/i);
    await expect(getUserSession("test_user_firm_noclient_user")).rejects.toBeInstanceOf(
      BullhornOAuthAppMissingError,
    );
    await expect(
      completeUserEnrollment("test_user_firm_noclient_user", "unused-code"),
    ).rejects.toThrow(/platform service client is not used/i);
    expect(fetchMock).not.toHaveBeenCalled();

    const { rows } = await pool.query(
      `
        SELECT refresh_token, bullhorn_refresh_generation, bullhorn_refresh_outcome
        FROM users WHERE id = 'test_user_firm_noclient_user'
      `,
    );
    expect(rows[0]).toMatchObject({
      refresh_token: "kept-refresh",
      bullhorn_refresh_generation: 0,
      bullhorn_refresh_outcome: "idle",
    });
    const dumped = await dumpFirmAndUsers("test_user_firm_noclient");
    assertSecretAbsent(dumped, RECRUITER_PASSWORD);
    assertSecretAbsent(logLines.join("\n"), RECRUITER_PASSWORD);
    expect(__bullhornAuthTestHooks.isDirectLoginCoolingDown()).toBe(false);
  });

  it("scrubs the recruiter password from enrollment failures", async () => {
    const client = storedClient();
    await seedFirmToken({
      firmId: "test_user_firm_redact",
      oauthUrl: "https://auth-east.example/oauth",
      loginUrl: "https://rest45.example/rest-services/login",
      oauthClientId: client.id,
      oauthClientSecret: client.secret,
    });
    await seedUser("test_user_firm_redact_user", "test_user_firm_redact", null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith(LOGIN_INFO)) {
          return json({
            oauthUrl: "https://auth-east.example/oauth",
            restUrl: "https://rest45.example/rest-services",
          });
        }
        throw new Error(`network down ${url}`);
      }),
    );

    let caught: Error | undefined;
    try {
      await enrollUserHeadless(
        "test_user_firm_redact_user",
        "qualified.recruiter",
        RECRUITER_PASSWORD,
      );
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/network down/);
    assertSecretAbsent(caught?.message ?? "", RECRUITER_PASSWORD);
    const dumped = await dumpFirmAndUsers("test_user_firm_redact");
    assertSecretAbsent(dumped, RECRUITER_PASSWORD);
    assertSecretAbsent(logLines.join("\n"), RECRUITER_PASSWORD);
    expect(__bullhornAuthTestHooks.isDirectLoginCoolingDown()).toBe(false);
  });
});
