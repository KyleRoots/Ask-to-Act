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
// Clerk mock.
//
// The portal endpoints bridge a Clerk session to a local AskToAct user. We
// replace @clerk/express with a controllable stub so a test can act as "signed
// out", "signed in as recruiter", or "signed in as admin" without a real Clerk
// session. The mutable `clerkState` is read on every request.
//   - clerkMiddleware -> passthrough (app.ts only uses it to populate getAuth,
//     which we stub directly).
//   - getAuth         -> returns the current userId (null = signed out).
//   - clerkClient.users.getUser -> returns the current email so requireClerkUser
//     can match it against the users table.
// ---------------------------------------------------------------------------
const clerkState = vi.hoisted(() => ({
  userId: null as string | null,
  email: null as string | null,
}));

vi.mock("@clerk/express", () => ({
  clerkMiddleware:
    () =>
    (_req: unknown, _res: unknown, next: () => void): void =>
      next(),
  getAuth: () => ({ userId: clerkState.userId }),
  clerkClient: {
    users: {
      getUser: async (_id: string) => ({
        primaryEmailAddressId: "primary-email",
        emailAddresses: [
          { id: "primary-email", emailAddress: clerkState.email },
        ],
      }),
    },
  },
}));

const { default: app } = await import("../app.js");
const request = (await import("supertest")).default;
const { db, firmsTable, usersTable, toolUsageTable } = await import(
  "@workspace/db"
);
const { eq, inArray } = await import("drizzle-orm");

// ---------------------------------------------------------------------------
// Test fixtures. All ids/emails are namespaced so cleanup is safe and these
// rows never collide with real data.
// ---------------------------------------------------------------------------
const PREFIX = "test-task28";
const FIRM_A = `${PREFIX}-firm-a`;
const FIRM_B = `${PREFIX}-firm-b`;
const ADMIN_A = `${PREFIX}-admin-a`;
const RECRUITER_A = `${PREFIX}-recruiter-a`;
const DUP_A = `${PREFIX}-dup-a`;
const DUP_B = `${PREFIX}-dup-b`;

const ADMIN_A_EMAIL = `admin.${PREFIX}@example.com`;
const RECRUITER_A_EMAIL = `recruiter.${PREFIX}@example.com`;
// users.email carries a (case-sensitive) UNIQUE constraint, so the two
// fail-closed fixtures differ only in case. They are distinct values to the DB
// constraint, yet the middleware's `lower(email) = ...` lookup still matches
// BOTH rows — which is exactly the ambiguity the 409 must guard against.
const DUP_EMAIL_LOWER = `dupe.${PREFIX}@example.com`;
const DUP_EMAIL_MIXED = `Dupe.${PREFIX}@example.com`;

const ALL_FIRM_IDS = [FIRM_A, FIRM_B];
const ALL_USER_IDS = [ADMIN_A, RECRUITER_A, DUP_A, DUP_B];

const SERVICE_TOKEN = process.env["MCP_BEARER_TOKEN"];

const now = new Date();
const YEAR = now.getUTCFullYear();
const MONTH = now.getUTCMonth() + 1;

function setSignedOut() {
  clerkState.userId = null;
  clerkState.email = null;
}

function signInAs(userId: string, email: string) {
  clerkState.userId = userId;
  clerkState.email = email;
}

async function cleanup() {
  await db.delete(toolUsageTable).where(inArray(toolUsageTable.firmId, ALL_FIRM_IDS));
  await db.delete(usersTable).where(inArray(usersTable.id, ALL_USER_IDS));
  await db.delete(firmsTable).where(inArray(firmsTable.id, ALL_FIRM_IDS));
}

beforeAll(async () => {
  if (!SERVICE_TOKEN) {
    throw new Error("MCP_BEARER_TOKEN must be set for these tests to run.");
  }

  await cleanup();

  await db.insert(firmsTable).values([
    { id: FIRM_A, name: "Task28 Firm A" },
    { id: FIRM_B, name: "Task28 Firm B" },
  ]);

  await db.insert(usersTable).values([
    {
      id: ADMIN_A,
      name: "Admin A",
      email: ADMIN_A_EMAIL,
      apiKey: `${PREFIX}-key-admin-a`,
      firmId: FIRM_A,
      role: "admin",
    },
    {
      id: RECRUITER_A,
      name: "Recruiter A",
      email: RECRUITER_A_EMAIL,
      apiKey: `${PREFIX}-key-recruiter-a`,
      firmId: FIRM_A,
      role: "recruiter",
    },
    // Two users whose emails differ only in case across firms. The UNIQUE
    // constraint on users.email is case-sensitive, so both rows insert, yet
    // the middleware's case-insensitive lookup matches both — used to verify
    // the Clerk->user match fails closed on ambiguity.
    {
      id: DUP_A,
      name: "Dup A",
      email: DUP_EMAIL_LOWER,
      apiKey: `${PREFIX}-key-dup-a`,
      firmId: FIRM_A,
      role: "recruiter",
    },
    {
      id: DUP_B,
      name: "Dup B",
      email: DUP_EMAIL_MIXED,
      apiKey: `${PREFIX}-key-dup-b`,
      firmId: FIRM_B,
      role: "recruiter",
    },
  ]);

  // Usage for Firm A users (current month) plus a Firm B row that must NEVER
  // appear in Firm A's scoped results.
  await db.insert(toolUsageTable).values([
    {
      userId: ADMIN_A,
      firmId: FIRM_A,
      toolName: "search_candidates",
      year: YEAR,
      month: MONTH,
      callCount: 5,
      errorCount: 1,
    },
    {
      userId: RECRUITER_A,
      firmId: FIRM_A,
      toolName: "open_jobs_report",
      year: YEAR,
      month: MONTH,
      callCount: 3,
      errorCount: 0,
    },
    {
      userId: DUP_B,
      firmId: FIRM_B,
      toolName: "search_candidates",
      year: YEAR,
      month: MONTH,
      callCount: 99,
      errorCount: 0,
    },
  ]);
});

afterAll(async () => {
  await cleanup();
});

beforeEach(() => {
  setSignedOut();
});

// ---------------------------------------------------------------------------
// GET /api/firms/:id/usage/detail  — super-admin (service token) only
// ---------------------------------------------------------------------------
describe("GET /api/firms/:id/usage/detail", () => {
  it("returns 401 with no credentials", async () => {
    const res = await request(app).get(`/api/firms/${FIRM_A}/usage/detail`);
    expect(res.status).toBe(401);
  });

  it("returns 200 with the service bearer token", async () => {
    const res = await request(app)
      .get(`/api/firms/${FIRM_A}/usage/detail`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.body.year).toBe(YEAR);
    expect(res.body.month).toBe(MONTH);
    expect(Array.isArray(res.body.users)).toBe(true);

    // Scoped to Firm A only: Firm B's user must not appear.
    const ids = res.body.users.map((u: { userId: string }) => u.userId);
    expect(ids).toContain(ADMIN_A);
    expect(ids).toContain(RECRUITER_A);
    expect(ids).not.toContain(DUP_B);
  });

  it("returns 403 for a (non-service) user API key", async () => {
    const res = await request(app)
      .get(`/api/firms/${FIRM_A}/usage/detail`)
      .set("Authorization", `Bearer ${PREFIX}-key-recruiter-a`);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /api/portal/me  — Clerk-authenticated
// ---------------------------------------------------------------------------
describe("GET /api/portal/me", () => {
  it("returns 401 when not signed in", async () => {
    const res = await request(app).get("/api/portal/me");
    expect(res.status).toBe(401);
  });

  it("returns the signed-in user's own profile", async () => {
    signInAs(RECRUITER_A, RECRUITER_A_EMAIL);
    const res = await request(app).get("/api/portal/me");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(RECRUITER_A);
    expect(res.body.role).toBe("recruiter");
    expect(res.body.firmId).toBe(FIRM_A);
  });

  it("fails closed (409) when the email maps to more than one user", async () => {
    signInAs(DUP_A, DUP_EMAIL_LOWER);
    const res = await request(app).get("/api/portal/me");
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// GET /api/portal/team-usage  — Clerk-authenticated, firm-admin only
// ---------------------------------------------------------------------------
describe("GET /api/portal/team-usage", () => {
  it("returns 401 when not signed in", async () => {
    const res = await request(app).get("/api/portal/team-usage");
    expect(res.status).toBe(401);
  });

  it("returns 403 for a non-admin (recruiter)", async () => {
    signInAs(RECRUITER_A, RECRUITER_A_EMAIL);
    const res = await request(app).get("/api/portal/team-usage");
    expect(res.status).toBe(403);
  });

  it("returns 200 for an admin with data scoped to their own firm", async () => {
    signInAs(ADMIN_A, ADMIN_A_EMAIL);
    const res = await request(app).get("/api/portal/team-usage");

    expect(res.status).toBe(200);
    const ids = res.body.users.map((u: { userId: string }) => u.userId);
    // Only Firm A members — never Firm B's user, even though it has usage.
    expect(ids).toContain(ADMIN_A);
    expect(ids).toContain(RECRUITER_A);
    expect(ids).not.toContain(DUP_B);
    expect(ids).toEqual(
      expect.arrayContaining([ADMIN_A, RECRUITER_A, DUP_A]),
    );
  });
});
