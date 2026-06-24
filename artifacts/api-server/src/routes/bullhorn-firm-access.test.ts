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
// getBullhornFirmId mock.
//
// requireBullhornFirm calls getBullhornFirmId() to find out which firm the
// shared Bullhorn token is bound to. We intercept the module so each test can
// control the return value without touching the database.
//
// The mutable `bhState` is read on every call; set it before each test.
// ---------------------------------------------------------------------------
const bhState = vi.hoisted(() => ({
  boundFirmId: null as string | null,
}));

vi.mock("../lib/bullhorn-auth.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/bullhorn-auth.js")>();
  return {
    ...original,
    getBullhornFirmId: async () => bhState.boundFirmId,
  };
});

// ---------------------------------------------------------------------------
// Clerk mock (app.ts imports @clerk/express; stub it so the process does not
// try to contact Clerk's servers during the test run).
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

const { default: app } = await import("../app.js");
const request = (await import("supertest")).default;
const { db, firmsTable, usersTable } = await import("@workspace/db");
const { inArray } = await import("drizzle-orm");

// ---------------------------------------------------------------------------
// Test fixtures. All ids are namespaced so cleanup never touches real data.
// ---------------------------------------------------------------------------
const PREFIX = "test-task33";
const FIRM_A = `${PREFIX}-firm-a`;
const FIRM_B = `${PREFIX}-firm-b`;
const USER_A = `${PREFIX}-user-a`;   // belongs to Firm A
const USER_B = `${PREFIX}-user-b`;   // belongs to Firm B (the "wrong" firm)
const USER_NOFIRM = `${PREFIX}-user-nofirm`; // no firmId on the user row

const ALL_FIRM_IDS = [FIRM_A, FIRM_B];
const ALL_USER_IDS = [USER_A, USER_B, USER_NOFIRM];

const SERVICE_TOKEN = process.env["MCP_BEARER_TOKEN"];

// The probe endpoint: GET /api/v1/reports calls listReports() which is pure
// static data — no live Bullhorn session required. It sits behind bearerAuth
// + requireBullhornFirm in routes/index.ts, making it ideal for isolation
// testing without side-effects.
const PROBE = "/api/v1/reports";

async function cleanup() {
  await db.delete(usersTable).where(inArray(usersTable.id, ALL_USER_IDS));
  await db.delete(firmsTable).where(inArray(firmsTable.id, ALL_FIRM_IDS));
}

beforeAll(async () => {
  if (!SERVICE_TOKEN) {
    throw new Error("MCP_BEARER_TOKEN must be set for these tests to run.");
  }

  await cleanup();

  await db.insert(firmsTable).values([
    { id: FIRM_A, name: "Task33 Firm A" },
    { id: FIRM_B, name: "Task33 Firm B" },
  ]);

  await db.insert(usersTable).values([
    {
      id: USER_A,
      name: "User A",
      email: `user-a.${PREFIX}@example.com`,
      apiKey: `${PREFIX}-key-user-a`,
      firmId: FIRM_A,
      role: "recruiter",
    },
    {
      id: USER_B,
      name: "User B",
      email: `user-b.${PREFIX}@example.com`,
      apiKey: `${PREFIX}-key-user-b`,
      firmId: FIRM_B,
      role: "recruiter",
    },
    {
      id: USER_NOFIRM,
      name: "User No Firm",
      email: `user-nofirm.${PREFIX}@example.com`,
      apiKey: `${PREFIX}-key-user-nofirm`,
      firmId: null,
      role: "recruiter",
    },
  ]);
});

afterAll(async () => {
  await cleanup();
});

beforeEach(() => {
  // Default: Bullhorn token is bound to Firm A.
  bhState.boundFirmId = FIRM_A;
});

// ---------------------------------------------------------------------------
// requireBullhornFirm: unauthenticated callers
// ---------------------------------------------------------------------------
describe("requireBullhornFirm — unauthenticated", () => {
  it("returns 401 with no Authorization header", async () => {
    const res = await request(app).get(PROBE);
    expect(res.status).toBe(401);
  });

  it("returns 401 with an invalid token", async () => {
    const res = await request(app)
      .get(PROBE)
      .set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// requireBullhornFirm: service token bypass
// ---------------------------------------------------------------------------
describe("requireBullhornFirm — service token", () => {
  it("returns 200 for the service bearer token (bypasses firm check)", async () => {
    const res = await request(app)
      .get(PROBE)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(200);
    // Confirm we received the reports list, not an error body.
    expect(res.body).toHaveProperty("reports");
  });
});

// ---------------------------------------------------------------------------
// requireBullhornFirm: correct-firm user is permitted
// ---------------------------------------------------------------------------
describe("requireBullhornFirm — correct-firm user", () => {
  it("returns 200 when the caller's firmId matches the Bullhorn-bound firmId", async () => {
    // bhState.boundFirmId = FIRM_A (set in beforeEach); USER_A.firmId = FIRM_A
    const res = await request(app)
      .get(PROBE)
      .set("Authorization", `Bearer ${PREFIX}-key-user-a`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("reports");
  });
});

// ---------------------------------------------------------------------------
// requireBullhornFirm: wrong-firm user is blocked
// ---------------------------------------------------------------------------
describe("requireBullhornFirm — wrong-firm user", () => {
  it("returns 403 when the caller's firmId does not match the Bullhorn-bound firmId", async () => {
    // USER_B.firmId = FIRM_B, but boundFirmId = FIRM_A → mismatch
    const res = await request(app)
      .get(PROBE)
      .set("Authorization", `Bearer ${PREFIX}-key-user-b`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not authorized/i);
  });
});

// ---------------------------------------------------------------------------
// requireBullhornFirm: Bullhorn token has no firmId bound
// ---------------------------------------------------------------------------
describe("requireBullhornFirm — no firmId bound", () => {
  beforeEach(() => {
    // Override: simulate an unbound (legacy / not-yet-configured) connection.
    bhState.boundFirmId = null;
  });

  it("returns 403 for any user caller when no firmId is bound", async () => {
    const res = await request(app)
      .get(PROBE)
      .set("Authorization", `Bearer ${PREFIX}-key-user-a`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not yet bound|re-authoris/i);
  });

  it("still returns 200 for the service token even when no firmId is bound", async () => {
    // Service callers are the administrators who set up the connection;
    // they must not be blocked by an unbound token.
    const res = await request(app)
      .get(PROBE)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(200);
  });
});
