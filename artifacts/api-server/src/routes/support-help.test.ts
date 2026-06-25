import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// POST /api/support/help — the PUBLIC (unauthenticated) help form behind the
// connector setup page. It must NOT require a Clerk session, must validate
// input, must short-circuit honeypot submissions WITHOUT sending, and must
// route a valid request through sendSupportEmail (to SUPPORT_EMAIL).
//
// We mock @clerk/express to a passthrough (app.ts wires it globally) and mock
// emailService so no real email is sent and we can assert how it was called.
//
// NOTE: the route has a dedicated limiter of 5 requests / 10 min / IP. All
// supertest requests share one IP, so this file deliberately stays at/under 5
// passing requests to avoid tripping the limiter mid-suite.
// ---------------------------------------------------------------------------
vi.mock("@clerk/express", () => ({
  clerkMiddleware:
    () =>
    (_req: unknown, _res: unknown, next: () => void): void =>
      next(),
  getAuth: () => ({ userId: null }),
  clerkClient: { users: { getUser: async () => ({}) } },
}));

const emailMock = vi.hoisted(() => ({
  sendSupportEmail: vi.fn(async (_arg: unknown) => undefined),
}));

vi.mock("../lib/emailService.js", () => ({
  sendSupportEmail: emailMock.sendSupportEmail,
}));

const { default: app } = await import("../app.js");
const request = (await import("supertest")).default;

beforeEach(() => {
  emailMock.sendSupportEmail.mockClear();
});

describe("POST /api/support/help", () => {
  it("rejects an invalid email without sending", async () => {
    const res = await request(app)
      .post("/api/support/help")
      .send({ email: "not-an-email", message: "this is a long enough message" });

    expect(res.status).toBe(400);
    expect(emailMock.sendSupportEmail).not.toHaveBeenCalled();
  });

  it("rejects a too-short message without sending", async () => {
    const res = await request(app)
      .post("/api/support/help")
      .send({ email: "user@example.com", message: "hi" });

    expect(res.status).toBe(400);
    expect(emailMock.sendSupportEmail).not.toHaveBeenCalled();
  });

  it("treats a filled honeypot as success but sends nothing", async () => {
    const res = await request(app).post("/api/support/help").send({
      email: "user@example.com",
      message: "this is a perfectly valid looking message",
      website: "http://spam.example.com",
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(emailMock.sendSupportEmail).not.toHaveBeenCalled();
  });

  it("sends a valid request through sendSupportEmail with the right shape", async () => {
    const res = await request(app).post("/api/support/help").send({
      name: "Jane Recruiter",
      email: "jane@example.com",
      message: "I'm stuck on the ChatGPT connector step — can you help?",
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(emailMock.sendSupportEmail).toHaveBeenCalledTimes(1);

    const arg = emailMock.sendSupportEmail.mock.calls[0]![0] as {
      type: string;
      subject: string;
      message: string;
      userName: string;
      userEmail: string;
    };
    expect(arg.type).toBe("question");
    expect(arg.userEmail).toBe("jane@example.com");
    expect(arg.userName).toBe("Jane Recruiter");
    expect(arg.subject).toContain("Jane Recruiter");
    expect(arg.message).toContain("ChatGPT connector");
  });
});
