import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Clerk mock — app.ts imports @clerk/express; stub it so the process does not
// contact Clerk's servers during the test run. The enroll GET route is
// unauthenticated (token in the query string), so no Clerk identity is needed.
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

// Stub only getAuthorizeUrl so the default redirect path doesn't hit Bullhorn's
// live endpoint-discovery; everything else in bullhorn-auth runs for real.
vi.mock("../lib/bullhorn-auth.js", async (importActual) => {
  const actual = await importActual<typeof import("../lib/bullhorn-auth.js")>();
  return {
    ...actual,
    getAuthorizeUrl: async (_state: string) =>
      "https://auth.bullhorn.example/oauth/authorize?fake=1",
  };
});

const { default: app } = await import("../app.js");
const request = (await import("supertest")).default;
const { db, firmsTable, usersTable } = await import("@workspace/db");
const { inArray } = await import("drizzle-orm");

const PREFIX = "test-bouncerec";
const FIRM = `${PREFIX}-firm`;
const USER = `${PREFIX}-user`;
const TOKEN = `${PREFIX}-enrolltoken`;
const COOKIE = "a2a_enroll_started";

// A user mid-enrollment: valid one-time enroll token, NOT yet connected to
// Bullhorn (refreshToken null) — the exact state in which a consent bounce
// leaves someone.
const UNCONNECTED = {
  id: USER,
  name: "Bounce Tester",
  email: "bounce-tester@example.com",
  apiKey: `${PREFIX}-key`,
  firmId: FIRM,
  role: "recruiter",
  refreshToken: null as string | null,
  enrollToken: TOKEN as string | null,
  enrollTokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
};

async function cleanup() {
  await db.delete(usersTable).where(inArray(usersTable.id, [USER]));
  await db.delete(firmsTable).where(inArray(firmsTable.id, [FIRM]));
}

beforeAll(async () => {
  await cleanup();
  // `subscriptionStatus: active` so the enroll route's subscription gate passes.
  await db
    .insert(firmsTable)
    .values({ id: FIRM, name: "Bounce Test Firm", status: "active", subscriptionStatus: "active" });
});

afterAll(cleanup);

beforeEach(async () => {
  await db.delete(usersTable).where(inArray(usersTable.id, [USER]));
  await db.insert(usersTable).values(UNCONNECTED);
});

describe("GET /api/auth/user/enroll — first-time consent bounce recovery", () => {
  it("shows the recovery page when the browser returns after an attempt (cookie set, still unconnected)", async () => {
    const res = await request(app)
      .get(`/api/auth/user/enroll?token=${TOKEN}`)
      .set("Cookie", `${COOKIE}=${USER}`);

    expect(res.status).toBe(200);
    // Offers both a retry of the OAuth flow and the manual fallback…
    expect(res.text).toContain(`token=${TOKEN}&go=1`);
    expect(res.text).toContain(`token=${TOKEN}&manual=1`);
    expect(res.text).toContain("Connect manually");
    // …and does NOT redirect to Bullhorn.
    expect(res.headers["location"]).toBeUndefined();
  });

  it("redirects to Bullhorn AND sets the attempt cookie on first visit (no cookie yet)", async () => {
    const res = await request(app).get(`/api/auth/user/enroll?token=${TOKEN}`);
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toContain("auth.bullhorn.example");
    // The attempt cookie is planted so a later bounce return is detectable.
    const setCookie = res.headers["set-cookie"];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie ?? "");
    expect(cookieHeader).toContain(`${COOKIE}=`);
  });

  it("does NOT show recovery for a mismatched cookie (different user's attempt)", async () => {
    const res = await request(app)
      .get(`/api/auth/user/enroll?token=${TOKEN}`)
      .set("Cookie", `${COOKIE}=some-other-user-id`);
    expect(res.status).toBe(302);
    expect(res.text).not.toContain("Let's finish connecting Bullhorn");
  });

  it("forces the redirect with ?go=1 even when the cookie matches (retry bypasses recovery)", async () => {
    const res = await request(app)
      .get(`/api/auth/user/enroll?token=${TOKEN}&go=1`)
      .set("Cookie", `${COOKIE}=${USER}`);
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toContain("auth.bullhorn.example");
    expect(res.text).not.toContain("Let's finish connecting Bullhorn");
  });
});
