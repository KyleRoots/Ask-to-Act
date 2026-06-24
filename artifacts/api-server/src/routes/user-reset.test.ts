import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Clerk mock — app.ts imports @clerk/express; stub it so the process does not
// contact Clerk's servers during the test run. These routes are service-token
// guarded (requireService), so no Clerk identity is needed.
// ---------------------------------------------------------------------------
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

// invalidateUserSession touches an in-memory cache; the real implementation is
// harmless in tests, so we let it run via the real module.

const { default: app } = await import("../app.js");
const request = (await import("supertest")).default;
const { db, firmsTable, usersTable } = await import("@workspace/db");
const { inArray, eq } = await import("drizzle-orm");

const PREFIX = "test-userreset";
const FIRM = `${PREFIX}-firm`;
const USER = `${PREFIX}-user`;

const ALL_FIRM_IDS = [FIRM];
const ALL_USER_IDS = [USER];

const SERVICE_TOKEN = process.env["MCP_BEARER_TOKEN"];

// A fully "onboarded" fixture: has a Bullhorn connection + session + api key
// and a consumed (null) enroll token, exactly the state reset must clear.
const ONBOARDED = {
  id: USER,
  name: "Reset Tester",
  email: "reset-tester@example.com",
  apiKey: `${PREFIX}-oldkey`,
  firmId: FIRM,
  role: "admin",
  refreshToken: "old-refresh-token",
  bhRestToken: "old-rest-token",
  restUrl: "https://rest.bullhorn.example/",
  tokenExpiresAt: Date.now() + 60_000,
  sessionExpiresAt: Date.now() + 60_000,
  enrollToken: null as string | null,
  enrollTokenExpiresAt: null as Date | null,
};

async function cleanup() {
  await db.delete(usersTable).where(inArray(usersTable.id, ALL_USER_IDS));
  await db.delete(firmsTable).where(inArray(firmsTable.id, ALL_FIRM_IDS));
}

beforeAll(async () => {
  if (!SERVICE_TOKEN) {
    throw new Error("MCP_BEARER_TOKEN must be set for these tests to run.");
  }
  await cleanup();
  await db.insert(firmsTable).values({ id: FIRM, name: "Reset Test Firm", status: "active" });
});

afterAll(cleanup);

beforeEach(async () => {
  await db.delete(usersTable).where(inArray(usersTable.id, ALL_USER_IDS));
  await db.insert(usersTable).values(ONBOARDED);
});

describe("POST /api/users/:id/reset", () => {
  it("rejects unauthenticated callers (401)", async () => {
    const res = await request(app).post(`/api/users/${USER}/reset`);
    expect(res.status).toBe(401);
  });

  it("rejects an authenticated non-service caller (403)", async () => {
    // A valid user apiKey authenticates as a user, but reset is service-only.
    const res = await request(app)
      .post(`/api/users/${USER}/reset`)
      .set("Authorization", `Bearer ${ONBOARDED.apiKey}`);
    expect(res.status).toBe(403);
  });

  it("rejects an unrecognized bearer token (401)", async () => {
    const res = await request(app)
      .post(`/api/users/${USER}/reset`)
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown user", async () => {
    const res = await request(app)
      .post(`/api/users/${PREFIX}-missing/reset`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it("clears the Bullhorn connection + session, rotates the api key, and issues a fresh enroll link", async () => {
    const res = await request(app)
      .post(`/api/users/${USER}/reset`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(USER);
    expect(typeof res.body.apiKey).toBe("string");
    expect(res.body.apiKey).not.toBe(ONBOARDED.apiKey);
    expect(res.body.enrollUrl).toContain("/api/auth/user/enroll?token=");

    const [row] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, USER))
      .limit(1);

    // Bullhorn connection + session fully cleared
    expect(row!.refreshToken).toBeNull();
    expect(row!.bhRestToken).toBeNull();
    expect(row!.restUrl).toBeNull();
    expect(row!.tokenExpiresAt).toBeNull();
    expect(row!.sessionExpiresAt).toBeNull();

    // api key rotated
    expect(row!.apiKey).toBe(res.body.apiKey);
    expect(row!.apiKey).not.toBe(ONBOARDED.apiKey);

    // fresh, valid enroll token issued
    expect(row!.enrollToken).toBeTruthy();
    expect(row!.enrollTokenExpiresAt).toBeTruthy();
    expect(row!.enrollTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    // identity preserved
    expect(row!.name).toBe(ONBOARDED.name);
    expect(row!.email).toBe(ONBOARDED.email);
    expect(row!.firmId).toBe(FIRM);
    expect(row!.role).toBe("admin");
  });

  it("makes the user appear un-enrolled in GET /api/users after reset", async () => {
    await request(app)
      .post(`/api/users/${USER}/reset`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .expect(200);

    const res = await request(app)
      .get(`/api/users`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .expect(200);

    const me = (res.body as Array<{ id: string; enrolled: boolean; enrollUrl: string | null }>).find(
      (u) => u.id === USER,
    );
    expect(me).toBeTruthy();
    expect(me!.enrolled).toBe(false);
    expect(me!.enrollUrl).toContain("/api/auth/user/enroll?token=");
  });
});
