import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/express", () => ({
  clerkMiddleware:
    () =>
    (_req: unknown, _res: unknown, next: () => void): void =>
      next(),
  getAuth: () => ({ userId: null }),
  clerkClient: {
    users: {
      getUser: async (_id: string) => ({
        primaryEmailAddressId: "primary-email",
        emailAddresses: [{ id: "primary-email", emailAddress: null }],
      }),
    },
  },
}));

const { default: app } = await import("../app.js");
const request = (await import("supertest")).default;
const { db, firmsTable, bullhornTokensTable } = await import("@workspace/db");
const { eq, inArray } = await import("drizzle-orm");
const { decryptToken } = await import("../lib/token-crypto.js");
const { logger } = await import("../lib/logger.js");
const { __bullhornAuthTestHooks } = await import("../lib/bullhorn-auth.js");

const SERVICE_TOKEN = process.env["MCP_BEARER_TOKEN"];
const PREVIOUS_ENV = {
  TOKEN_ENCRYPTION_KEY: process.env["TOKEN_ENCRYPTION_KEY"],
  BULLHORN_CLIENT_ID: process.env["BULLHORN_CLIENT_ID"],
  BULLHORN_CLIENT_SECRET: process.env["BULLHORN_CLIENT_SECRET"],
  BULLHORN_USERNAME: process.env["BULLHORN_USERNAME"],
  BULLHORN_PASSWORD: process.env["BULLHORN_PASSWORD"],
  BULLHORN_REDIRECT_URI: process.env["BULLHORN_REDIRECT_URI"],
  QUALIFIED_BULLHORN_API_PASSWORD: process.env["QUALIFIED_BULLHORN_API_PASSWORD"],
};

const PREFIX = "test-firm-connect";
const SERVICE_FIRM = `${PREFIX}-service`;
const PLATFORM_FIRM = `${PREFIX}-platform`;
const CUSTOMER_FIRM = `${PREFIX}-customer`;
const OTHER_FIRM = `${PREFIX}-other`;
const FIRM_IDS = [SERVICE_FIRM, PLATFORM_FIRM, CUSTOMER_FIRM, OTHER_FIRM];

const ENV_CLIENT_ID = "env-client-id";
const ENV_CLIENT_SECRET = "env-client-secret";
const ENV_USERNAME = "myticas-service-user";
const ENV_PASSWORD = "myticas-service-password";
const ENV_REDIRECT = "https://connect.example/oauth/callback";
const QUALIFIED_ENV_PASSWORD = "qualified-env-password-sentinel";

const FIRM_CLIENT_ID = "firm-client-id";
const FIRM_CLIENT_SECRET = "firm-client-secret";
const FIRM_USERNAME = "firm.api.user";
const FIRM_PASSWORD = "firm-api-password";
const OTHER_USERNAME = "other.api.user";
const OTHER_PASSWORD = "other-api-password";
const FIRM_REFRESH = "firm-refresh-token";
const OAUTH_URL = "https://auth.firm.example/oauth";
const REST_URL = "https://rest.firm.example/rest-services";
const LOGIN_URL = `${REST_URL}/login`;

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function bodyText(body: RequestInit["body"]): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return "";
}

async function storeClient(firmId: string): Promise<void> {
  const res = await request(app)
    .post(`/api/firms/${firmId}/bullhorn-oauth-client`)
    .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
    .send({ clientId: FIRM_CLIENT_ID, clientSecret: FIRM_CLIENT_SECRET });
  expect(res.status).toBe(200);
}

async function readToken(firmId: string) {
  const [row] = await db
    .select({
      refreshToken: bullhornTokensTable.refreshToken,
      oauthUrl: bullhornTokensTable.oauthUrl,
      loginUrl: bullhornTokensTable.loginUrl,
      restUrl: bullhornTokensTable.restUrl,
      oauthClientId: bullhornTokensTable.oauthClientId,
      oauthClientSecret: bullhornTokensTable.oauthClientSecret,
      usesPlatformClient: bullhornTokensTable.usesPlatformClient,
      authMode: bullhornTokensTable.authMode,
      authHealthy: bullhornTokensTable.authHealthy,
      lastAuthError: bullhornTokensTable.lastAuthError,
    })
    .from(bullhornTokensTable)
    .where(eq(bullhornTokensTable.firmId, firmId));
  return row;
}

function successFetch(username: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const target = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (target.includes("loginInfo")) {
      expect(new URL(target).searchParams.get("username")).toBe(username);
      return jsonResponse({ oauthUrl: OAUTH_URL, restUrl: REST_URL });
    }
    if (target.includes("/authorize") && method === "GET") {
      const params = new URL(target).searchParams;
      expect(params.get("client_id")).toBe(FIRM_CLIENT_ID);
      expect(params.get("username")).toBe(username);
      expect(params.get("password")).toBe(username === OTHER_USERNAME ? OTHER_PASSWORD : FIRM_PASSWORD);
      expect(params.get("action")).toBe("Login");
      return redirectResponse(`${ENV_REDIRECT}?code=firm-code`);
    }
    if (target.includes("/token")) {
      const stored = await readToken(username === OTHER_USERNAME ? OTHER_FIRM : CUSTOMER_FIRM);
      expect(stored?.oauthUrl).toBe(OAUTH_URL);
      expect(stored?.loginUrl).toBe(LOGIN_URL);
      expect(stored?.refreshToken).toBe("");
      const params = new URLSearchParams(bodyText(init?.body));
      expect(params.get("client_id")).toBe(FIRM_CLIENT_ID);
      expect(params.get("client_secret")).toBe(FIRM_CLIENT_SECRET);
      expect(params.get("grant_type")).toBe("authorization_code");
      expect(params.get("redirect_uri")).toBe(ENV_REDIRECT);
      return jsonResponse({
        access_token: "firm-access-token",
        refresh_token: FIRM_REFRESH,
        expires_in: 600,
      });
    }
    if (target.includes("/ping")) {
      return jsonResponse({ sessionExpires: Date.now() + 600_000 });
    }
    if (target.includes("/login")) {
      expect(new URL(target).searchParams.get("access_token")).toBe("firm-access-token");
      return jsonResponse({
        BhRestToken: "bh-rest-token",
        restUrl: `${REST_URL}/session1/`,
      });
    }
    throw new Error(`unexpected Bullhorn call ${method} ${target}`);
  });
  globalThis.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

beforeAll(async () => {
  if (!SERVICE_TOKEN) {
    throw new Error("MCP_BEARER_TOKEN must be set for these tests to run.");
  }
  process.env["TOKEN_ENCRYPTION_KEY"] = randomBytes(32).toString("base64");
  process.env["BULLHORN_CLIENT_ID"] = ENV_CLIENT_ID;
  process.env["BULLHORN_CLIENT_SECRET"] = ENV_CLIENT_SECRET;
  process.env["BULLHORN_USERNAME"] = ENV_USERNAME;
  process.env["BULLHORN_PASSWORD"] = ENV_PASSWORD;
  process.env["BULLHORN_REDIRECT_URI"] = ENV_REDIRECT;
  process.env["QUALIFIED_BULLHORN_API_PASSWORD"] = QUALIFIED_ENV_PASSWORD;
  await db.delete(bullhornTokensTable).where(inArray(bullhornTokensTable.firmId, FIRM_IDS));
  await db.delete(firmsTable).where(inArray(firmsTable.id, FIRM_IDS));
  await db.insert(firmsTable).values([
    { id: SERVICE_FIRM, name: "Connect service firm" },
    { id: PLATFORM_FIRM, name: "Connect platform firm" },
    { id: CUSTOMER_FIRM, name: "Connect customer firm" },
    { id: OTHER_FIRM, name: "Connect other firm" },
  ]);
});

beforeEach(async () => {
  __bullhornAuthTestHooks.resetAuthState();
  globalThis.fetch = (async () => {
    throw new Error("live Bullhorn fetch is not allowed in this test");
  }) as typeof fetch;
  await db.delete(bullhornTokensTable).where(inArray(bullhornTokensTable.firmId, FIRM_IDS));
  await db.insert(bullhornTokensTable).values([
    {
      id: SERVICE_FIRM,
      firmId: SERVICE_FIRM,
      refreshToken: `${PREFIX}-service-refresh`,
      oauthUrl: "https://oauth.service.example",
      restUrl: "https://rest.service.example/rest-services/session",
      loginUrl: "https://rest.service.example/rest-services/login",
      authMode: "service",
      authHealthy: true,
      usesPlatformClient: true,
    },
    {
      id: PLATFORM_FIRM,
      firmId: PLATFORM_FIRM,
      refreshToken: `${PREFIX}-platform-refresh`,
      oauthUrl: "https://oauth.platform.example",
      loginUrl: "https://rest.platform.example/rest-services/login",
      authMode: "oauth",
      authHealthy: true,
      usesPlatformClient: true,
      oauthClientId: "platform-stored-client",
      oauthClientSecret: "platform-stored-secret",
    },
  ]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.delete(bullhornTokensTable).where(inArray(bullhornTokensTable.firmId, FIRM_IDS));
  await db.delete(firmsTable).where(inArray(firmsTable.id, FIRM_IDS));
  for (const [key, value] of Object.entries(PREVIOUS_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("POST /api/firms/:id/bullhorn-connect", () => {
  it("rejects a missing token and a missing firm without calling Bullhorn", async () => {
    const missing = await request(app)
      .post("/api/firms/does-not-exist/bullhorn-connect")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ username: FIRM_USERNAME, password: FIRM_PASSWORD });
    expect(missing.status).toBe(404);
    expect(JSON.stringify(missing.body)).not.toContain(FIRM_PASSWORD);

    const unauthenticated = await request(app)
      .post(`/api/firms/${CUSTOMER_FIRM}/bullhorn-connect`)
      .send({ username: FIRM_USERNAME, password: FIRM_PASSWORD });
    expect(unauthenticated.status).toBe(401);

    const noClient = await request(app)
      .post(`/api/firms/${CUSTOMER_FIRM}/bullhorn-connect`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ username: FIRM_USERNAME, password: FIRM_PASSWORD });
    expect(noClient.status).toBe(409);
    expect(noClient.body.error).toMatch(/client/i);
    expect(JSON.stringify(noClient.body)).not.toContain(FIRM_PASSWORD);

    await db.insert(bullhornTokensTable).values({
      id: CUSTOMER_FIRM,
      firmId: CUSTOMER_FIRM,
      refreshToken: "",
      authMode: "oauth",
      authHealthy: false,
      usesPlatformClient: false,
    });
    const missingClient = await request(app)
      .post(`/api/firms/${CUSTOMER_FIRM}/bullhorn-connect`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ username: FIRM_USERNAME, password: FIRM_PASSWORD });
    expect(missingClient.status).toBe(409);
    expect(missingClient.body.error).toMatch(/client/i);
    expect(JSON.stringify(missingClient.body)).not.toContain(FIRM_PASSWORD);
  });

  it("refuses service and platform-client firms before any Bullhorn call", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("Bullhorn should not be called");
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const service = await request(app)
      .post(`/api/firms/${SERVICE_FIRM}/bullhorn-connect`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ username: FIRM_USERNAME, password: FIRM_PASSWORD });
    expect(service.status).toBe(409);
    expect(JSON.stringify(service.body)).not.toContain(FIRM_PASSWORD);

    const platform = await request(app)
      .post(`/api/firms/${PLATFORM_FIRM}/bullhorn-connect`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ username: FIRM_USERNAME, password: FIRM_PASSWORD });
    expect(platform.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();

    const serviceRow = await readToken(SERVICE_FIRM);
    expect(serviceRow?.authMode).toBe("service");
    expect(serviceRow?.refreshToken).toBe(`${PREFIX}-service-refresh`);
    expect(serviceRow?.oauthClientId).toBeNull();
    const platformRow = await readToken(PLATFORM_FIRM);
    expect(platformRow?.usesPlatformClient).toBe(true);
    expect(platformRow?.oauthClientId).toBe("platform-stored-client");
    expect(platformRow?.refreshToken).toBe(`${PREFIX}-platform-refresh`);
  });

  it("saves the firm swimlane before token exchange and does not keep the password", async () => {
    await storeClient(CUSTOMER_FIRM);
    const logged: unknown[] = [];
    vi.spyOn(logger, "info").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    vi.spyOn(logger, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("loginInfo")) {
        expect(new URL(target).searchParams.get("username")).toBe(FIRM_USERNAME);
        expect(target).not.toContain(ENV_USERNAME);
        return jsonResponse({ oauthUrl: `${OAUTH_URL}/`, restUrl: REST_URL });
      }
      if (target.includes("/authorize")) {
        throw new Error(`authorize failed ${FIRM_PASSWORD}`);
      }
      if (target.includes("/token")) {
        throw new Error("token exchange must not run when authorize fails");
      }
      throw new Error(`unexpected Bullhorn call ${target} ${bodyText(init?.body)}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const res = await request(app)
      .post(`/api/firms/${CUSTOMER_FIRM}/bullhorn-connect`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ username: `  ${FIRM_USERNAME}  `, password: FIRM_PASSWORD });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Bullhorn connect failed." });
    expect(JSON.stringify(res.body)).not.toContain(FIRM_PASSWORD);
    expect(JSON.stringify(logged)).not.toContain(FIRM_PASSWORD);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/token"))).toBe(false);

    const row = await readToken(CUSTOMER_FIRM);
    expect(row?.oauthUrl).toBe(OAUTH_URL);
    expect(row?.loginUrl).toBe(LOGIN_URL);
    expect(row?.refreshToken).toBe("");
    expect(row?.authMode).toBe("oauth");
    expect(row?.usesPlatformClient).toBe(false);
    expect(row?.authHealthy).toBe(false);
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(FIRM_PASSWORD);
    expect(stored).not.toContain(FIRM_USERNAME);
    expect(decryptToken(row!.oauthClientSecret!)).toBe(FIRM_CLIENT_SECRET);
    expect(__bullhornAuthTestHooks.isDirectLoginCoolingDown()).toBe(false);
  });

  it("exchanges a direct authorization code with the stored client when consent already exists", async () => {
    await storeClient(CUSTOMER_FIRM);
    successFetch(FIRM_USERNAME);
    const res = await request(app)
      .post(`/api/firms/${CUSTOMER_FIRM}/bullhorn-connect`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ username: FIRM_USERNAME, password: FIRM_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, firmId: CUSTOMER_FIRM, authMode: "oauth" });
    expect(JSON.stringify(res.body)).not.toContain(FIRM_PASSWORD);
    expect(JSON.stringify(res.body)).not.toContain(FIRM_CLIENT_SECRET);
    const row = await readToken(CUSTOMER_FIRM);
    expect(row?.authMode).toBe("oauth");
    expect(row?.usesPlatformClient).toBe(false);
    expect(row?.oauthUrl).toBe(OAUTH_URL);
    expect(decryptToken(row!.refreshToken)).toBe(FIRM_REFRESH);
    expect(JSON.stringify(row)).not.toContain(FIRM_PASSWORD);
    expect(__bullhornAuthTestHooks.isDirectLoginCoolingDown()).toBe(false);
  });

  it("connects with the stored client, including a first-time consent page", async () => {
    await storeClient(CUSTOMER_FIRM);
    const logged: unknown[] = [];
    vi.spyOn(logger, "info").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    vi.spyOn(logger, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (target.includes("loginInfo")) {
        expect(new URL(target).searchParams.get("username")).toBe(FIRM_USERNAME);
        return jsonResponse({ oauthUrl: OAUTH_URL, restUrl: REST_URL });
      }
      if (target.includes("/authorize") && method === "GET") {
        const params = new URL(target).searchParams;
        expect(params.get("client_id")).toBe(FIRM_CLIENT_ID);
        expect(params.get("client_id")).not.toBe(ENV_CLIENT_ID);
        expect(params.get("password")).toBe(FIRM_PASSWORD);
        expect(params.get("password")).not.toBe(ENV_PASSWORD);
        expect(params.get("password")).not.toBe(QUALIFIED_ENV_PASSWORD);
        return new Response(
          `<html><form id="consentForm"><input type="hidden" name="consent" value="yes">Get Consent</form></html>`,
          {
            status: 200,
            headers: { "content-type": "text/html", "set-cookie": "JSESSIONID=firm-session; Path=/" },
          },
        );
      }
      if (target.includes("/authorize") && method === "POST") {
        expect(bodyText(init?.body)).toContain("action=Agree");
        expect(bodyText(init?.body)).toContain("consent=yes");
        const headers = new Headers(init?.headers);
        expect(headers.get("cookie")).toBe("JSESSIONID=firm-session");
        expect(new URL(target).searchParams.get("client_id")).toBe(FIRM_CLIENT_ID);
        return redirectResponse(`${ENV_REDIRECT}?code=consent-code`);
      }
      if (target.includes("/token")) {
        const stored = await readToken(CUSTOMER_FIRM);
        expect(stored?.oauthUrl).toBe(OAUTH_URL);
        expect(stored?.loginUrl).toBe(LOGIN_URL);
        expect(stored?.refreshToken).toBe("");
        const params = new URLSearchParams(bodyText(init?.body));
        expect(params.get("client_id")).toBe(FIRM_CLIENT_ID);
        expect(params.get("client_secret")).toBe(FIRM_CLIENT_SECRET);
        expect(params.get("client_secret")).not.toBe(ENV_CLIENT_SECRET);
        expect(params.get("code")).toBe("consent-code");
        return jsonResponse({
          access_token: "firm-access-token",
          refresh_token: FIRM_REFRESH,
          expires_in: 600,
        });
      }
      if (target.includes("/ping")) {
        return jsonResponse({ sessionExpires: Date.now() + 600_000 });
      }
      if (target.includes("/login")) {
        return jsonResponse({
          BhRestToken: "bh-rest-token",
          restUrl: `${REST_URL}/session1/`,
        });
      }
      throw new Error(`unexpected Bullhorn call ${method} ${target}`);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const res = await request(app)
      .post(`/api/firms/${CUSTOMER_FIRM}/bullhorn-connect`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ username: FIRM_USERNAME, password: FIRM_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, firmId: CUSTOMER_FIRM, authMode: "oauth" });
    expect(JSON.stringify(res.body)).not.toContain(FIRM_PASSWORD);
    expect(JSON.stringify(res.body)).not.toContain(FIRM_REFRESH);
    expect(JSON.stringify(logged)).not.toContain(FIRM_PASSWORD);
    expect(JSON.stringify(logged)).not.toContain(FIRM_CLIENT_SECRET);

    const row = await readToken(CUSTOMER_FIRM);
    expect(row?.authMode).toBe("oauth");
    expect(row?.usesPlatformClient).toBe(false);
    expect(row?.authHealthy).toBe(true);
    expect(row?.oauthUrl).toBe(OAUTH_URL);
    expect(row?.loginUrl).toBe(LOGIN_URL);
    expect(decryptToken(row!.refreshToken)).toBe(FIRM_REFRESH);
    expect(decryptToken(row!.oauthClientId!)).toBe(FIRM_CLIENT_ID);
    expect(decryptToken(row!.oauthClientSecret!)).toBe(FIRM_CLIENT_SECRET);
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(FIRM_PASSWORD);
    expect(stored).not.toContain(FIRM_USERNAME);
    expect(__bullhornAuthTestHooks.isDirectLoginCoolingDown()).toBe(false);
  });

  it("keeps a per-firm cooldown off the Myticas breaker and still uses the env client there", async () => {
    await storeClient(CUSTOMER_FIRM);
    await storeClient(OTHER_FIRM);
    const failing = vi.fn(async (url: unknown) => {
      const target = String(url);
      if (target.includes("loginInfo")) {
        expect(new URL(target).searchParams.get("username")).toBe(FIRM_USERNAME);
        return jsonResponse({ error: "nope" }, 500);
      }
      throw new Error(`unexpected Bullhorn call ${target}`);
    });
    globalThis.fetch = failing as typeof fetch;

    const first = await request(app)
      .post(`/api/firms/${CUSTOMER_FIRM}/bullhorn-connect`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ username: FIRM_USERNAME, password: FIRM_PASSWORD });
    expect(first.status).toBe(502);
    expect(JSON.stringify(first.body)).not.toContain(FIRM_PASSWORD);
    expect(__bullhornAuthTestHooks.isDirectLoginCoolingDown()).toBe(false);

    const blockedFetch = vi.fn(async () => {
      throw new Error("cooled-down firm must not call Bullhorn");
    });
    globalThis.fetch = blockedFetch as typeof fetch;
    const second = await request(app)
      .post(`/api/firms/${CUSTOMER_FIRM}/bullhorn-connect`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ username: FIRM_USERNAME, password: FIRM_PASSWORD });
    expect(second.status).toBe(429);
    expect(second.body.error).toMatch(/this firm/i);
    expect(JSON.stringify(second.body)).not.toContain(FIRM_PASSWORD);
    expect(blockedFetch).not.toHaveBeenCalled();

    successFetch(OTHER_USERNAME);
    const other = await request(app)
      .post(`/api/firms/${OTHER_FIRM}/bullhorn-connect`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ username: OTHER_USERNAME, password: OTHER_PASSWORD });
    expect(other.status).toBe(200);
    expect(other.body.authMode).toBe("oauth");

    const stillBlocked = await request(app)
      .post(`/api/firms/${CUSTOMER_FIRM}/bullhorn-connect`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ username: FIRM_USERNAME, password: FIRM_PASSWORD });
    expect(stillBlocked.status).toBe(429);

    const serviceFetch = vi.fn(async (url: unknown) => {
      const target = String(url);
      if (target.includes("loginInfo")) {
        expect(new URL(target).searchParams.get("username")).toBe(ENV_USERNAME);
        return jsonResponse({
          oauthUrl: "https://auth.service.example/oauth",
          restUrl: "https://rest.service.example/rest-services",
        });
      }
      if (target.includes("/authorize")) {
        const params = new URL(target).searchParams;
        expect(params.get("client_id")).toBe(ENV_CLIENT_ID);
        expect(params.get("username")).toBe(ENV_USERNAME);
        expect(params.get("password")).toBe(ENV_PASSWORD);
        return redirectResponse(`${ENV_REDIRECT}?code=service-code`);
      }
      throw new Error(`unexpected service call ${target}`);
    });
    globalThis.fetch = serviceFetch as typeof fetch;
    const serviceCallsBefore = serviceFetch.mock.calls.length;
    const service = await __bullhornAuthTestHooks.serviceHeadlessAuthCode();
    expect(service.code).toBe("service-code");
    expect(serviceFetch.mock.calls.length).toBeGreaterThan(serviceCallsBefore);
    expect(__bullhornAuthTestHooks.isDirectLoginCoolingDown()).toBe(false);

    const afterService = serviceFetch.mock.calls.length;
    const cooled = await request(app)
      .post(`/api/firms/${CUSTOMER_FIRM}/bullhorn-connect`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ username: FIRM_USERNAME, password: FIRM_PASSWORD });
    expect(cooled.status).toBe(429);
    expect(serviceFetch.mock.calls.length).toBe(afterService);
  });

  it("rejects a blank password before calling Bullhorn", async () => {
    await storeClient(CUSTOMER_FIRM);
    const fetchMock = vi.fn(async () => {
      throw new Error("Bullhorn should not be called");
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const res = await request(app)
      .post(`/api/firms/${CUSTOMER_FIRM}/bullhorn-connect`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ username: FIRM_USERNAME, password: "" });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain(FIRM_USERNAME);
  });
});
