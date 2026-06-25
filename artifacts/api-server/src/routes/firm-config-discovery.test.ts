import { describe, it, expect, beforeAll, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Service-firm discovery protection.
//
// The "service" firm (Myticas) is the env-credential headless account whose
// custom-field config is managed by the platform. It MUST keep NO firm_config
// row so resolution stays on the byte-identical fallback path. A super-admin
// must not be able to run discovery against it (which would persist a row and
// silently change its behaviour). These tests lock that invariant at the
// route level — they are fully read-only: the 409 fires before any Bullhorn
// call or DB write.
// ---------------------------------------------------------------------------

// Clerk mock (app.ts imports @clerk/express; stub it so the process does not
// try to contact Clerk's servers during the test run).
import { vi } from "vitest";
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
const { db, firmsTable, firmConfigTable, bullhornTokensTable } = await import(
  "@workspace/db"
);
const { eq, inArray } = await import("drizzle-orm");

const SERVICE_TOKEN = process.env["MCP_BEARER_TOKEN"];

// A namespaced control firm: a normal firm with NO Bullhorn connection. Used to
// prove the service guard is specific (it must NOT fire for a normal firm).
const PREFIX = "test-task54";
const CONTROL_FIRM = `${PREFIX}-firm-control`;

// Resolved in beforeAll: the real service firm's id (the row whose auth_mode is
// "service"). Looking it up by definition keeps the test resilient to id
// changes instead of hardcoding a production firm id.
let SERVICE_FIRM_ID = "";

beforeAll(async () => {
  if (!SERVICE_TOKEN) {
    throw new Error("MCP_BEARER_TOKEN must be set for these tests to run.");
  }

  const rows = await db
    .select({ firmId: bullhornTokensTable.firmId })
    .from(bullhornTokensTable)
    .where(eq(bullhornTokensTable.authMode, "service"))
    .limit(1);
  const serviceFirmId = rows[0]?.firmId;
  if (!serviceFirmId) {
    throw new Error(
      "No service-mode Bullhorn firm found; the service firm fixture is required.",
    );
  }
  SERVICE_FIRM_ID = serviceFirmId;

  await db.delete(firmsTable).where(inArray(firmsTable.id, [CONTROL_FIRM]));
  await db.insert(firmsTable).values([{ id: CONTROL_FIRM, name: "Task54 Control Firm" }]);
});

afterAll(async () => {
  await db.delete(firmConfigTable).where(eq(firmConfigTable.firmId, CONTROL_FIRM));
  await db.delete(firmsTable).where(inArray(firmsTable.id, [CONTROL_FIRM]));
});

describe("POST /api/firms/:id/discover-config — service firm protection", () => {
  it("rejects discovery for the service firm with a clear 409 (config stays managed)", async () => {
    const res = await request(app)
      .post(`/api/firms/${SERVICE_FIRM_ID}/discover-config`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/service configuration|managed by the platform/i);
  });

  it("leaves the service firm with NO custom-field config row (byte-identical fallback)", async () => {
    const res = await request(app)
      .get(`/api/firms/${SERVICE_FIRM_ID}/config`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.discovered).toBe(false);
    expect(res.body.fieldMap).toBeNull();

    // Strongest form of the invariant: assert at the DB layer that no row exists.
    const rows = await db
      .select({ firmId: firmConfigTable.firmId })
      .from(firmConfigTable)
      .where(eq(firmConfigTable.firmId, SERVICE_FIRM_ID));
    expect(rows).toHaveLength(0);
  });

  it("rejects a normal unconnected firm for a DIFFERENT reason (connection, not service)", async () => {
    const res = await request(app)
      .post(`/api/firms/${CONTROL_FIRM}/discover-config`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(409);
    // The connection guard, NOT the service guard, must be the one that fired.
    expect(res.body.error).toMatch(/not active|connect bullhorn/i);
    expect(res.body.error).not.toMatch(/service configuration|managed by the platform/i);
  });
});
