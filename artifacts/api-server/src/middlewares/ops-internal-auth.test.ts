import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import { requireOpsInternalAuth } from "./ops-internal-auth.js";

const SERVICE_TOKEN = "a".repeat(64);
const OPS_SECRET = "b".repeat(64);
// Shape of a recruiter key issued to a portal user: a valid credential for the
// MCP tool routes (bearerAuth resolves it against users.api_key) and therefore
// the credential an ops agent is most likely to be handed by mistake.
const PORTAL_USER_KEY = "c".repeat(64);

function mockRes() {
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.payload = body;
      return res;
    },
  } as Response & { statusCode: number; payload: unknown };
  return res;
}

function run(authorization?: string) {
  const res = mockRes();
  let nextCalled = false;
  const headers = authorization === undefined ? {} : { authorization };
  requireOpsInternalAuth({ headers } as Request, res, () => {
    nextCalled = true;
  });
  return {
    res,
    nextCalled,
    error: (res.payload as { error?: string } | undefined)?.error,
  };
}

describe("requireOpsInternalAuth", () => {
  const env = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...env };
    process.env["MCP_BEARER_TOKEN"] = SERVICE_TOKEN;
    process.env["OPS_HEALTH_SECRET"] = OPS_SECRET;
  });

  afterEach(() => {
    process.env = env;
  });

  it("accepts the service bearer token", () => {
    const { nextCalled, res } = run(`Bearer ${SERVICE_TOKEN}`);
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("accepts the dedicated ops secret", () => {
    const { nextCalled, res } = run(`Bearer ${OPS_SECRET}`);
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("tolerates surrounding whitespace in the header value", () => {
    const { nextCalled } = run(`Bearer   ${SERVICE_TOKEN}  `);
    expect(nextCalled).toBe(true);
  });

  it("rejects a portal user API key with 403", () => {
    // Ops endpoints expose cross-firm operational state, so a recruiter key
    // must never reach them. When an agent's ops-health call 403s, the fix is
    // to supply the service bearer — never to widen this gate.
    const { nextCalled, res, error } = run(`Bearer ${PORTAL_USER_KEY}`);
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(error).toContain("invalid ops credentials");
  });

  it("rejects a token that only shares a prefix with the real secret", () => {
    const { nextCalled, res } = run(`Bearer ${SERVICE_TOKEN.slice(0, 32)}`);
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("fails closed with 403 when no ops credential is configured", () => {
    delete process.env["MCP_BEARER_TOKEN"];
    delete process.env["OPS_HEALTH_SECRET"];

    const { nextCalled, res } = run(`Bearer ${SERVICE_TOKEN}`);
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("accepts the ops secret when only it is configured", () => {
    delete process.env["MCP_BEARER_TOKEN"];

    const { nextCalled } = run(`Bearer ${OPS_SECRET}`);
    expect(nextCalled).toBe(true);
  });

  it("returns 401 when the Authorization header is absent", () => {
    const { nextCalled, res, error } = run();
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(error).toContain("Missing Authorization");
  });

  it("returns 401 for a non-Bearer scheme", () => {
    const { nextCalled, res } = run(
      `Basic ${Buffer.from(`ops:${SERVICE_TOKEN}`).toString("base64")}`,
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});
