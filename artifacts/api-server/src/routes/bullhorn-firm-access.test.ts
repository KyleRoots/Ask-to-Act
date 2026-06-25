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
// isFirmConnected mock.
//
// requireBullhornFirm calls isFirmConnected(firmId) to check whether THE
// CALLER'S firm has its own Bullhorn workspace connected (a token row exists).
// We intercept the module so each test can control which firms are "connected"
// without touching the database.
//
// The mutable `bhState.connectedFirmIds` is read on every call; set it before
// each test.
// ---------------------------------------------------------------------------
const bhState = vi.hoisted(() => ({
  connectedFirmIds: new Set<string>(),
}));

vi.mock("../lib/bullhorn-auth.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/bullhorn-auth.js")>();
  return {
    ...original,
    isFirmConnected: async (firmId: string) => bhState.connectedFirmIds.has(firmId),
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
const { inArray, eq } = await import("drizzle-orm");

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
  // Default: Firm A has its own Bullhorn workspace connected; Firm B does not.
  bhState.connectedFirmIds = new Set([FIRM_A]);
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
describe("requireBullhornFirm — connected-firm user", () => {
  it("returns 200 when the caller's firm has its own Bullhorn connection", async () => {
    // FIRM_A connected (set in beforeEach); USER_A.firmId = FIRM_A
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
describe("requireBullhornFirm — unconnected-firm user", () => {
  it("returns 403 when the caller's own firm has no Bullhorn connection", async () => {
    // USER_B.firmId = FIRM_B, which is NOT in connectedFirmIds → not connected
    const res = await request(app)
      .get(PROBE)
      .set("Authorization", `Bearer ${PREFIX}-key-user-b`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not connected/i);
  });
});

// ---------------------------------------------------------------------------
// requireBullhornFirm: Bullhorn token has no firmId bound
// ---------------------------------------------------------------------------
describe("requireBullhornFirm — no firm connected", () => {
  beforeEach(() => {
    // Override: simulate a deployment where no firm has connected Bullhorn yet.
    bhState.connectedFirmIds = new Set();
  });

  it("returns 403 for any user caller when their firm is not connected", async () => {
    const res = await request(app)
      .get(PROBE)
      .set("Authorization", `Bearer ${PREFIX}-key-user-a`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not connected|complete Bullhorn setup/i);
  });

  it("still returns 200 for the service token even when no firm is connected", async () => {
    // Service callers are the administrators who set up the connection;
    // they must not be blocked by an unbound token.
    const res = await request(app)
      .get(PROBE)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// requireBullhornFirm: firm lifecycle status gate (suspend / archive)
//
// Even a correctly-bound, correct-firm user must be cut off from the live AI
// tool path once their firm is suspended or archived. Reactivating restores it.
// ---------------------------------------------------------------------------
describe("requireBullhornFirm — firm lifecycle status", () => {
  afterAll(async () => {
    // Restore Firm A to active so it can never leak a suspended state into
    // other suites that share these fixtures.
    await db
      .update(firmsTable)
      .set({ status: "active" })
      .where(eq(firmsTable.id, FIRM_A));
  });

  it("returns 403 for a correct-firm user when the firm is suspended", async () => {
    await db
      .update(firmsTable)
      .set({ status: "suspended" })
      .where(eq(firmsTable.id, FIRM_A));

    const res = await request(app)
      .get(PROBE)
      .set("Authorization", `Bearer ${PREFIX}-key-user-a`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/suspended/i);
  });

  it("returns 403 for a correct-firm user when the firm is archived", async () => {
    await db
      .update(firmsTable)
      .set({ status: "archived" })
      .where(eq(firmsTable.id, FIRM_A));

    const res = await request(app)
      .get(PROBE)
      .set("Authorization", `Bearer ${PREFIX}-key-user-a`);
    expect(res.status).toBe(403);
  });

  it("restores access (200) once the firm is reactivated", async () => {
    await db
      .update(firmsTable)
      .set({ status: "active" })
      .where(eq(firmsTable.id, FIRM_A));

    const res = await request(app)
      .get(PROBE)
      .set("Authorization", `Bearer ${PREFIX}-key-user-a`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("reports");
  });

  it("still returns 200 for the service token even when the firm is suspended", async () => {
    await db
      .update(firmsTable)
      .set({ status: "suspended" })
      .where(eq(firmsTable.id, FIRM_A));

    const res = await request(app)
      .get(PROBE)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/firms/:id — service-only status mutation + validation
// ---------------------------------------------------------------------------
describe("PATCH /api/firms/:id", () => {
  afterAll(async () => {
    await db
      .update(firmsTable)
      .set({ status: "active" })
      .where(eq(firmsTable.id, FIRM_A));
  });

  it("returns 401 with no credentials", async () => {
    const res = await request(app)
      .patch(`/api/firms/${FIRM_A}`)
      .send({ status: "suspended" });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-service user API key", async () => {
    const res = await request(app)
      .patch(`/api/firms/${FIRM_A}`)
      .set("Authorization", `Bearer ${PREFIX}-key-user-a`)
      .send({ status: "suspended" });
    expect(res.status).toBe(403);
  });

  it("returns 400 for an invalid status value", async () => {
    const res = await request(app)
      .patch(`/api/firms/${FIRM_A}`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ status: "deleted" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown firm", async () => {
    const res = await request(app)
      .patch(`/api/firms/${PREFIX}-does-not-exist`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ status: "suspended" });
    expect(res.status).toBe(404);
  });

  it("updates the status with the service token", async () => {
    const res = await request(app)
      .patch(`/api/firms/${FIRM_A}`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ status: "archived" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("archived");
  });
});

// ---------------------------------------------------------------------------
// GET /api/firms — archived firms hidden by default
// ---------------------------------------------------------------------------
describe("GET /api/firms — archived filtering", () => {
  beforeAll(async () => {
    await db
      .update(firmsTable)
      .set({ status: "archived" })
      .where(eq(firmsTable.id, FIRM_B));
  });

  afterAll(async () => {
    await db
      .update(firmsTable)
      .set({ status: "active" })
      .where(eq(firmsTable.id, FIRM_B));
  });

  it("hides archived firms by default", async () => {
    const res = await request(app)
      .get("/api/firms")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((f: { id: string }) => f.id);
    expect(ids).not.toContain(FIRM_B);
  });

  it("includes archived firms when ?includeArchived=1", async () => {
    const res = await request(app)
      .get("/api/firms?includeArchived=1")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((f: { id: string }) => f.id);
    expect(ids).toContain(FIRM_B);
  });
});
