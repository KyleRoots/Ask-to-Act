import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

const SERVICE_TOKEN = process.env["MCP_BEARER_TOKEN"];
const PREVIOUS_ENCRYPTION_KEY = process.env["TOKEN_ENCRYPTION_KEY"];
const PREFIX = "test-oauth-client";
const SERVICE_FIRM = `${PREFIX}-service`;
const OAUTH_FIRM = `${PREFIX}-oauth`;
const CLIENT_ID = "route-client-id";
const CLIENT_SECRET = "route-client-secret-value";

async function cleanup(): Promise<void> {
  await db.delete(bullhornTokensTable).where(
    inArray(bullhornTokensTable.firmId, [SERVICE_FIRM, OAUTH_FIRM]),
  );
  await db.delete(firmsTable).where(inArray(firmsTable.id, [SERVICE_FIRM, OAUTH_FIRM]));
}

beforeAll(async () => {
  if (!SERVICE_TOKEN) {
    throw new Error("MCP_BEARER_TOKEN must be set for these tests to run.");
  }
  process.env["TOKEN_ENCRYPTION_KEY"] = randomBytes(32).toString("base64");
  await cleanup();
  await db.insert(firmsTable).values([
    { id: SERVICE_FIRM, name: "OAuth client service firm" },
    { id: OAUTH_FIRM, name: "OAuth client customer firm" },
  ]);
  await db.insert(bullhornTokensTable).values({
    id: SERVICE_FIRM,
    firmId: SERVICE_FIRM,
    refreshToken: `${PREFIX}-service-refresh`,
    oauthUrl: "https://oauth.test.invalid",
    restUrl: "https://rest.test.invalid/rest-services/session",
    loginUrl: "https://rest.test.invalid/rest-services/login",
    authMode: "service",
    authHealthy: true,
  });
});

afterAll(async () => {
  await cleanup();
  if (PREVIOUS_ENCRYPTION_KEY === undefined) {
    delete process.env["TOKEN_ENCRYPTION_KEY"];
  } else {
    process.env["TOKEN_ENCRYPTION_KEY"] = PREVIOUS_ENCRYPTION_KEY;
  }
});

describe("POST /api/firms/:id/bullhorn-oauth-client", () => {
  it("rejects the service firm and leaves the env-client columns empty", async () => {
    const res = await request(app)
      .post(`/api/firms/${SERVICE_FIRM}/bullhorn-oauth-client`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toContain(CLIENT_SECRET);

    const [row] = await db
      .select({
        oauthClientId: bullhornTokensTable.oauthClientId,
        oauthClientSecret: bullhornTokensTable.oauthClientSecret,
        refreshToken: bullhornTokensTable.refreshToken,
        authMode: bullhornTokensTable.authMode,
      })
      .from(bullhornTokensTable)
      .where(eq(bullhornTokensTable.firmId, SERVICE_FIRM));
    expect(row?.oauthClientId).toBeNull();
    expect(row?.oauthClientSecret).toBeNull();
    expect(row?.authMode).toBe("service");
    expect(row?.refreshToken).toBe(`${PREFIX}-service-refresh`);
  });

  it("stores encrypted client material from the body and does not echo it", async () => {
    const res = await request(app)
      .post(`/api/firms/${OAUTH_FIRM}/bullhorn-oauth-client`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, firmId: OAUTH_FIRM });
    expect(JSON.stringify(res.body)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(res.body)).not.toContain(CLIENT_ID);

    const [row] = await db
      .select({
        oauthClientId: bullhornTokensTable.oauthClientId,
        oauthClientSecret: bullhornTokensTable.oauthClientSecret,
        refreshToken: bullhornTokensTable.refreshToken,
        authMode: bullhornTokensTable.authMode,
        authHealthy: bullhornTokensTable.authHealthy,
      })
      .from(bullhornTokensTable)
      .where(eq(bullhornTokensTable.firmId, OAUTH_FIRM));
    expect(row?.refreshToken).toBe("");
    expect(row?.authMode).toBe("oauth");
    expect(row?.authHealthy).toBe(false);
    expect(row?.oauthClientId?.startsWith("enc:v1:")).toBe(true);
    expect(row?.oauthClientSecret?.startsWith("enc:v1:")).toBe(true);
    expect(decryptToken(row!.oauthClientId!)).toBe(CLIENT_ID);
    expect(decryptToken(row!.oauthClientSecret!)).toBe(CLIENT_SECRET);
  });

  it("requires the service bearer and a real firm", async () => {
    const missingAuth = await request(app)
      .post(`/api/firms/${OAUTH_FIRM}/bullhorn-oauth-client`)
      .send({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(missingAuth.status).toBe(401);

    const missingFirm = await request(app)
      .post("/api/firms/test-oauth-client-missing/bullhorn-oauth-client")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(missingFirm.status).toBe(404);
  });
});
