import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// ---------------------------------------------------------------------------
// New-organization wizard: end-to-end route sequence.
//
// Tests every API route the NewOrganizationWizard calls for a brand-new firm:
//   1. POST /api/firms              — create the firm record
//   2. GET  /api/auth/bullhorn/login-url — get OAuth popup URL
//   3. GET  /api/auth/bullhorn/status    — connection false before OAuth
//   4. POST /api/firms/:id/discover-config — 409 until connected
//   5. POST /api/auth/bullhorn/verify     — 409 until connected
//   6. POST /api/users              — create the first admin user
//   7. GET  /api/firms/:id          — summary detail loads correctly
//
// None of these require a live Bullhorn account. They exercise the full wizard
// control-flow paths up to the point where the OAuth popup would open and lock
// the pre-connect guard invariants.
//
// When a real second Bullhorn account is available, a super-admin should walk
// through steps 1–7 in the admin wizard UI and confirm:
//   - The OAuth popup completes without "invalid redirect_uri" errors
//   - POST /discover-config returns discovered field mappings for that tenant
//   - POST /verify returns ok:true with a live candidate count from that tenant
//   - MCP reads for the new firm show only that firm's Bullhorn data (isolation)
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
const { db, firmsTable, usersTable, bullhornTokensTable } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");

const SERVICE_TOKEN = process.env["MCP_BEARER_TOKEN"];
const PREFIX = "test-task55";

// Resolved by the create-firm test; shared across all subsequent steps.
let createdFirmId = "";

async function cleanup() {
  if (!createdFirmId) return;
  await db.delete(usersTable).where(eq(usersTable.firmId, createdFirmId));
  await db.delete(bullhornTokensTable).where(eq(bullhornTokensTable.firmId, createdFirmId));
  await db.delete(firmsTable).where(eq(firmsTable.id, createdFirmId));
}

beforeAll(async () => {
  if (!SERVICE_TOKEN) throw new Error("MCP_BEARER_TOKEN must be set for these tests.");
});

afterAll(async () => {
  await cleanup();
});

// ---------------------------------------------------------------------------
// Step 1: Create the firm record
// ---------------------------------------------------------------------------
describe("Step 1 — POST /api/firms", () => {
  it("creates a new firm and returns id + name", async () => {
    const res = await request(app)
      .post("/api/firms")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ name: `${PREFIX} Test Firm`, seatLimit: 5 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(`${PREFIX} Test Firm`);
    expect(typeof res.body.id).toBe("string");
    createdFirmId = res.body.id;
  });

  it("rejects a firm with a blank name", async () => {
    const res = await request(app)
      .post("/api/firms")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ name: "  " });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it("requires the service token — 401 without credentials", async () => {
    const res = await request(app)
      .post("/api/firms")
      .send({ name: "Should be blocked" });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Step 2: Get the Bullhorn OAuth login URL
// ---------------------------------------------------------------------------
describe("Step 2 — GET /api/auth/bullhorn/login-url", () => {
  it("returns a url field when firmId is provided", async () => {
    expect(createdFirmId).toBeTruthy();
    const res = await request(app)
      .get(`/api/auth/bullhorn/login-url?firmId=${createdFirmId}`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.url).toBe("string");
    // The URL must point to the Bullhorn authorize endpoint.
    expect(res.body.url).toContain("authorize");
  });

  it("returns 400 when firmId query param is absent", async () => {
    const res = await request(app)
      .get("/api/auth/bullhorn/login-url")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/firmId/i);
  });

  it("requires the service token — 401 without credentials", async () => {
    expect(createdFirmId).toBeTruthy();
    const res = await request(app)
      .get(`/api/auth/bullhorn/login-url?firmId=${createdFirmId}`);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Step 3: Poll connection status — false before OAuth completes
// ---------------------------------------------------------------------------
describe("Step 3 — GET /api/auth/bullhorn/status", () => {
  it("returns connected:false for a newly created firm with no token row", async () => {
    expect(createdFirmId).toBeTruthy();
    const res = await request(app)
      .get(`/api/auth/bullhorn/status?firmId=${createdFirmId}`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
  });

  it("returns 400 when firmId is absent", async () => {
    const res = await request(app)
      .get("/api/auth/bullhorn/status")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Step 4: Discover config — 409 until Bullhorn is connected
// ---------------------------------------------------------------------------
describe("Step 4 — POST /api/firms/:id/discover-config (pre-connect gate)", () => {
  it("returns 409 because the firm's Bullhorn is not yet connected", async () => {
    expect(createdFirmId).toBeTruthy();
    const res = await request(app)
      .post(`/api/firms/${createdFirmId}/discover-config`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not active|connect bullhorn/i);
  });

  it("returns 404 for an unknown firm", async () => {
    const res = await request(app)
      .post(`/api/firms/${PREFIX}-no-such-firm/discover-config`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Step 5: Verify — 409 until Bullhorn is connected
// ---------------------------------------------------------------------------
describe("Step 5 — POST /api/auth/bullhorn/verify (pre-connect gate)", () => {
  it("returns 409 because the firm's Bullhorn is not yet connected", async () => {
    expect(createdFirmId).toBeTruthy();
    const res = await request(app)
      .post("/api/auth/bullhorn/verify")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ firmId: createdFirmId });
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/not active/i);
  });

  it("returns 400 when firmId is missing from body/query", async () => {
    const res = await request(app)
      .post("/api/auth/bullhorn/verify")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Step 5b: Activate the firm as pilot before adding users.
// The wizard shows an "Activate as pilot" button when no subscription is live.
// Without activation the user-creation step returns 402 (subscription gate).
// ---------------------------------------------------------------------------
describe("Step 5b — POST /api/firms/:id/activate (pilot gate)", () => {
  it("activates the new firm as a pilot so users can be added", async () => {
    expect(createdFirmId).toBeTruthy();
    const res = await request(app)
      .post(`/api/firms/${createdFirmId}/activate`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ seatLimit: 5, note: "wizard-onboarding test" });
    expect(res.status).toBe(200);
    expect(res.body.subscriptionStatus).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// Step 6: Create the first admin user under the new firm
// ---------------------------------------------------------------------------
describe("Step 6 — POST /api/users (first admin)", () => {
  it("creates an admin user scoped to the new firm", async () => {
    expect(createdFirmId).toBeTruthy();
    const res = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({
        name: `${PREFIX} Admin`,
        email: `admin.${PREFIX}@example.com`,
        firmId: createdFirmId,
        role: "admin",
      });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe(`${PREFIX} Admin`);
    expect(res.body.role).toBe("admin");
    expect(res.body.firmId).toBe(createdFirmId);
    expect(typeof res.body.enrollUrl).toBe("string");
  });

  it("rejects user creation that references a non-existent firmId", async () => {
    const res = await request(app)
      .post("/api/users")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ name: "Ghost", firmId: `${PREFIX}-no-such-firm`, role: "recruiter" });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Step 7: Firm summary — confirms enrolled seat count
// ---------------------------------------------------------------------------
describe("Step 7 — GET /api/firms/:id (wizard summary)", () => {
  it("returns the new firm's details with enrolledSeats reflecting the created admin", async () => {
    expect(createdFirmId).toBeTruthy();
    const res = await request(app)
      .get(`/api/firms/${createdFirmId}`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(createdFirmId);
    expect(res.body.name).toBe(`${PREFIX} Test Firm`);
    expect(res.body.enrolledSeats).toBe(1);
    expect(res.body.seatLimit).toBe(5);
  });

  it("returns 404 for an unknown firm", async () => {
    const res = await request(app)
      .get(`/api/firms/${PREFIX}-no-such-firm`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Isolation guard: new firm never pollutes the service firm's token row
// ---------------------------------------------------------------------------
describe("Tenant isolation — new firm does not touch the service firm", () => {
  it("the new firm has no Bullhorn token row (it has never completed OAuth)", async () => {
    expect(createdFirmId).toBeTruthy();
    const rows = await db
      .select({ firmId: bullhornTokensTable.firmId })
      .from(bullhornTokensTable)
      .where(eq(bullhornTokensTable.firmId, createdFirmId));
    expect(rows).toHaveLength(0);
  });

  it("the service firm's token row remains intact and marked as service mode", async () => {
    const serviceRows = await db
      .select({ authMode: bullhornTokensTable.authMode })
      .from(bullhornTokensTable)
      .where(eq(bullhornTokensTable.authMode, "service"))
      .limit(1);
    expect(serviceRows).toHaveLength(1);
    expect(serviceRows[0]!.authMode).toBe("service");
  });
});
