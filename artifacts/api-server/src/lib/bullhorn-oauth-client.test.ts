import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TokenRow = Record<string, unknown>;

const state = vi.hoisted(() => ({
  rows: [] as TokenRow[],
  inserts: [] as TokenRow[],
  updates: [] as TokenRow[],
}));

vi.mock("@workspace/db", () => {
  const selectChain = {
    from() {
      return selectChain;
    },
    where() {
      return selectChain;
    },
    limit: async () => state.rows,
  };
  const updateChain = {
    set(values: TokenRow) {
      state.updates.push(values);
      return updateChain;
    },
    where: async () => undefined,
  };
  const insertChain = {
    values(values: TokenRow) {
      state.inserts.push(values);
      return insertChain;
    },
  };
  return {
    db: {
      select: () => selectChain,
      update: () => updateChain,
      insert: () => insertChain,
    },
    bullhornTokensTable: {
      id: "id",
      firmId: "firmId",
      refreshToken: "refreshToken",
      oauthUrl: "oauthUrl",
      restUrl: "restUrl",
      loginUrl: "loginUrl",
      oauthClientId: "oauthClientId",
      oauthClientSecret: "oauthClientSecret",
      authMode: "authMode",
      authHealthy: "authHealthy",
      lastAuthErrorAt: "lastAuthErrorAt",
      lastAuthError: "lastAuthError",
    },
    usersTable: {},
    firmsTable: {},
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  sql: vi.fn(),
}));

const { encryptToken } = await import("./token-crypto.js");
const {
  BullhornDataCenterUnknownError,
  BullhornOAuthAppMissingError,
  BullhornOAuthClientStoreError,
} = await import("./bullhorn-oauth-app.js");
const {
  __bullhornAuthTestHooks,
  getAuthorizeUrl,
  isFirmConnected,
  saveFirmBullhornOAuthClient,
} = await import("./bullhorn-auth.js");

const originalEnv = { ...process.env };

function serviceRow(overrides: TokenRow = {}): TokenRow {
  return {
    refreshToken: "service-refresh",
    oauthUrl: "https://myticas-oauth.example",
    restUrl: "https://myticas-rest.example/rest-services/abc",
    loginUrl: "https://myticas-rest.example/rest-services/login",
    oauthClientId: null,
    oauthClientSecret: null,
    authMode: "service",
    authHealthy: true,
    refreshGeneration: 1,
    lastAuthErrorAt: null,
    lastAuthError: null,
    ...overrides,
  };
}

beforeEach(() => {
  state.rows = [];
  state.inserts = [];
  state.updates = [];
  __bullhornAuthTestHooks.resetAuthState();
  process.env["BULLHORN_CLIENT_ID"] = "myticas-client-id";
  process.env["BULLHORN_CLIENT_SECRET"] = "myticas-client-secret";
  process.env["BULLHORN_USERNAME"] = "myticas-api-user";
  process.env["BULLHORN_PASSWORD"] = "myticas-api-password";
  process.env["BULLHORN_REDIRECT_URI"] = "https://connect.example/callback";
  process.env["TOKEN_ENCRYPTION_KEY"] = randomBytes(32).toString("base64");
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
  __bullhornAuthTestHooks.resetAuthState();
});

describe("service firm headless login", () => {
  it("sends the env client id and BULLHORN_USERNAME", async () => {
    const seen: Array<{ url: string; username: string | null; clientId: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input);
        seen.push({
          url: url.origin + url.pathname,
          username: url.searchParams.get("username"),
          clientId: url.searchParams.get("client_id"),
        });
        if (url.pathname.endsWith("/loginInfo")) {
          return new Response(
            JSON.stringify({
              oauthUrl: "https://auth.example/oauth",
              restUrl: "https://rest.example/rest-services/abc",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(null, {
          status: 302,
          headers: { location: "https://connect.example/callback?code=auth-code" },
        });
      }),
    );

    const result = await __bullhornAuthTestHooks.serviceHeadlessAuthCode();
    expect(result.code).toBe("auth-code");
    expect(seen[0]?.url).toBe("https://rest.bullhornstaffing.com/rest-services/loginInfo");
    expect(seen[0]?.username).toBe("myticas-api-user");
    expect(seen[1]?.clientId).toBe("myticas-client-id");
    expect(seen[1]?.username).toBe("myticas-api-user");
    expect(seen.some((call) => call.clientId === "qualified-client-id")).toBe(false);
  });
});

describe("getAuthorizeUrl", () => {
  it("uses the env client id for a service firm", async () => {
    state.rows = [serviceRow()];
    const url = new URL(await getAuthorizeUrl("state-1", "firm-service"));
    expect(url.searchParams.get("client_id")).toBe("myticas-client-id");
    expect(url.origin).toBe("https://myticas-oauth.example");
  });

  it("fails closed for an oauth firm with no stored client and does not call Bullhorn", async () => {
    state.rows = [serviceRow({ authMode: "oauth", oauthUrl: null, loginUrl: null })];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getAuthorizeUrl("state-1", "firm-oauth")).rejects.toBeInstanceOf(
      BullhornOAuthAppMissingError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the stored client and refuses the service username lookup when the swimlane is unknown", async () => {
    const clientId = encryptToken("qualified-client-id");
    const clientSecret = encryptToken("qualified-client-secret");
    state.rows = [
      serviceRow({
        authMode: "oauth",
        refreshToken: "",
        oauthUrl: null,
        loginUrl: null,
        oauthClientId: clientId,
        oauthClientSecret: clientSecret,
      }),
    ];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getAuthorizeUrl("state-1", "firm-oauth")).rejects.toBeInstanceOf(
      BullhornDataCenterUnknownError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("puts the stored client id on the authorize URL", async () => {
    state.rows = [
      serviceRow({
        authMode: "oauth",
        oauthUrl: "https://qualified-oauth.example",
        loginUrl: "https://qualified-rest.example/login",
        oauthClientId: encryptToken("qualified-client-id"),
        oauthClientSecret: encryptToken("qualified-client-secret"),
      }),
    ];
    const url = new URL(await getAuthorizeUrl("state-1", "firm-oauth"));
    expect(url.searchParams.get("client_id")).toBe("qualified-client-id");
    expect(url.origin).toBe("https://qualified-oauth.example");
  });
});

describe("oauthAppFromTokenRow", () => {
  it("keeps the env client when a service row also has stored credentials", () => {
    const row = serviceRow({
      oauthClientId: encryptToken("qualified-client-id"),
      oauthClientSecret: encryptToken("qualified-client-secret"),
    });
    expect(
      __bullhornAuthTestHooks.oauthAppFromTokenRow({
        refreshToken: "service-refresh",
        encryptedRefreshToken: "service-refresh",
        oauthUrl: String(row["oauthUrl"]),
        restUrl: String(row["restUrl"]),
        loginUrl: String(row["loginUrl"]),
        encryptedClientId: String(row["oauthClientId"]),
        encryptedClientSecret: String(row["oauthClientSecret"]),
        authMode: "service",
        authHealthy: true,
        refreshGeneration: 1,
      }),
    ).toEqual({
      clientId: "myticas-client-id",
      clientSecret: "myticas-client-secret",
    });
  });
});

describe("saveFirmBullhornOAuthClient", () => {
  it("rejects the service firm and writes nothing", async () => {
    state.rows = [serviceRow()];
    await expect(
      saveFirmBullhornOAuthClient("firm-service", "qualified-client-id", "qualified-client-secret"),
    ).rejects.toBeInstanceOf(BullhornOAuthClientStoreError);
    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it("inserts encrypted credentials only, with an empty refresh token", async () => {
    state.rows = [];
    await saveFirmBullhornOAuthClient(
      "firm-oauth",
      "qualified-client-id",
      "qualified-client-secret",
    );
    expect(state.inserts).toHaveLength(1);
    const inserted = state.inserts[0]!;
    expect(inserted["refreshToken"]).toBe("");
    expect(inserted["authMode"]).toBe("oauth");
    expect(inserted["authHealthy"]).toBe(false);
    expect(String(inserted["oauthClientId"])).toMatch(/^enc:v1:/);
    expect(String(inserted["oauthClientSecret"])).toMatch(/^enc:v1:/);
    expect(JSON.stringify(inserted)).not.toContain("qualified-client-secret");
  });

  it("updates only the client columns on an existing oauth row", async () => {
    state.rows = [
      serviceRow({
        authMode: "oauth",
        refreshToken: "already-connected",
      }),
    ];
    await saveFirmBullhornOAuthClient(
      "firm-oauth",
      "qualified-client-id",
      "qualified-client-secret",
    );
    expect(state.inserts).toHaveLength(0);
    expect(state.updates).toHaveLength(1);
    expect(Object.keys(state.updates[0]!).sort()).toEqual([
      "oauthClientId",
      "oauthClientSecret",
      "updatedAt",
    ]);
  });

  it("does not write when encryption is unavailable", async () => {
    delete process.env["TOKEN_ENCRYPTION_KEY"];
    state.rows = [];
    await expect(
      saveFirmBullhornOAuthClient("firm-oauth", "qualified-client-id", "qualified-client-secret"),
    ).rejects.toBeInstanceOf(BullhornOAuthClientStoreError);
    expect(state.inserts).toHaveLength(0);
  });
});

describe("isFirmConnected", () => {
  it("treats a credentials-only row as disconnected", async () => {
    state.rows = [serviceRow({ authMode: "oauth", refreshToken: "" })];
    await expect(isFirmConnected("firm-oauth")).resolves.toBe(false);
  });

  it("stays connected when a refresh token is present", async () => {
    state.rows = [serviceRow()];
    await expect(isFirmConnected("firm-service")).resolves.toBe(true);
  });
});
