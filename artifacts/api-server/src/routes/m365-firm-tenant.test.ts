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
const { db, firmsTable, usersTable, pool } = await import("@workspace/db");
const { eq, inArray } = await import("drizzle-orm");
const { runAppMigrations } = await import("@workspace/db/run-migrations");

const SERVICE_TOKEN = process.env["MCP_BEARER_TOKEN"];
const PREFIX = "test-m365-tenant";
const MYTICAS = `${PREFIX}-myticas`;
const QUALIFIED = `${PREFIX}-qualified`;
const USER = `${PREFIX}-user`;
const QUALIFIED_TENANT = "9a416927-1992-4366-9314-d85dd684a3d1";

async function cleanup(): Promise<void> {
  await db.delete(usersTable).where(inArray(usersTable.id, [USER]));
  await db.delete(firmsTable).where(inArray(firmsTable.id, [MYTICAS, QUALIFIED]));
}

beforeAll(async () => {
  if (!SERVICE_TOKEN) {
    throw new Error("MCP_BEARER_TOKEN must be set for these tests to run.");
  }
  await runAppMigrations();
  await cleanup();
  await db.insert(firmsTable).values([
    { id: MYTICAS, name: "Tenant fallback firm" },
    { id: QUALIFIED, name: "Tenant customer firm" },
  ]);
  await db.insert(usersTable).values({
    id: USER,
    name: "Tenant recruiter",
    email: `${PREFIX}@example.com`,
    apiKey: `${PREFIX}-key`,
    firmId: QUALIFIED,
    role: "recruiter",
  });
});

afterAll(cleanup);

describe("PATCH /api/firms/:id/microsoft-tenant", () => {
  it("leaves a firm null until an admin sets it, and does not touch the other firm", async () => {
    const before = await pool.query(
      `SELECT id, microsoft_tenant_id FROM firms WHERE id = ANY($1::text[]) ORDER BY id`,
      [[MYTICAS, QUALIFIED]],
    );
    expect(before.rows).toEqual([
      { id: MYTICAS, microsoft_tenant_id: null },
      { id: QUALIFIED, microsoft_tenant_id: null },
    ]);

    const res = await request(app)
      .patch(`/api/firms/${QUALIFIED}/microsoft-tenant`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ microsoftTenantId: QUALIFIED_TENANT });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: QUALIFIED, microsoftTenantId: QUALIFIED_TENANT });

    const after = await db
      .select({ id: firmsTable.id, microsoftTenantId: firmsTable.microsoftTenantId })
      .from(firmsTable)
      .where(eq(firmsTable.id, MYTICAS));
    expect(after[0]?.microsoftTenantId).toBeNull();
  });

  it("rejects a recruiter API key and an invalid tenant id", async () => {
    const forbidden = await request(app)
      .patch(`/api/firms/${QUALIFIED}/microsoft-tenant`)
      .set("Authorization", `Bearer ${PREFIX}-key`)
      .send({ microsoftTenantId: QUALIFIED_TENANT });
    expect(forbidden.status).toBe(403);

    const invalid = await request(app)
      .patch(`/api/firms/${QUALIFIED}/microsoft-tenant`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ microsoftTenantId: "organizations" });
    expect(invalid.status).toBe(400);

    const stored = await db
      .select({ microsoftTenantId: firmsTable.microsoftTenantId })
      .from(firmsTable)
      .where(eq(firmsTable.id, QUALIFIED));
    expect(stored[0]?.microsoftTenantId).toBe(QUALIFIED_TENANT);
  });

  it("clears the tenant back to null", async () => {
    const res = await request(app)
      .patch(`/api/firms/${QUALIFIED}/microsoft-tenant`)
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ microsoftTenantId: null });
    expect(res.status).toBe(200);
    expect(res.body.microsoftTenantId).toBeNull();
  });
});
