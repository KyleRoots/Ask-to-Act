import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

/**
 * Unit coverage for the MCP/REST auth gates. The supertest suites exercise the
 * happy path against a database; these tests lock the branches that decide
 * whether a caller is a service admin, a firm user, or denied, without a DB.
 */

const SERVICE_TOKEN = "service-token-aaa";
const USER_KEY = "user-api-key-bbb";

type Health = {
  connected: boolean;
  healthy: boolean;
  needsReauthorization: boolean;
  lastAuthErrorAt: string | null;
  lastAuthError: string | null;
};

const healthy: Health = {
  connected: true,
  healthy: true,
  needsReauthorization: false,
  lastAuthErrorAt: null,
  lastAuthError: null,
};

const state = vi.hoisted(() => {
  let currentFirm: { firmId: string } | undefined;
  return {
    userRows: [] as Array<{ id: string; firmId: string | null }>,
    firmRows: [] as Array<{ status: string }>,
    userLookupError: null as Error | null,
    firmLookupError: null as Error | null,
    healthCalls: 0,
    lastFirmId: null as string | null,
    health: {
      connected: true,
      healthy: true,
      needsReauthorization: false,
      lastAuthErrorAt: null,
      lastAuthError: null,
    } as Health,
    healthError: null as Error | null,
    entitledError: null as unknown,
    // Same run/getStore contract attachFirmContext uses. A real AsyncLocalStorage
    // cannot be constructed in vi.hoisted without pulling Node into the hoist.
    firmContext: {
      run<T>(ctx: { firmId: string }, fn: () => T): T {
        const prev = currentFirm;
        currentFirm = ctx;
        try {
          return fn();
        } finally {
          currentFirm = prev;
        }
      },
      getStore(): { firmId: string } | undefined {
        return currentFirm;
      },
    },
  };
});

vi.mock("@workspace/db", () => ({
  usersTable: { id: "id", firmId: "firmId", apiKey: "apiKey" },
  firmsTable: { id: "id", status: "status" },
  db: {
    select: (shape: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if ("status" in shape) {
              if (state.firmLookupError) throw state.firmLookupError;
              return state.firmRows;
            }
            if (state.userLookupError) throw state.userLookupError;
            return state.userRows;
          },
        }),
      }),
    }),
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({ op: "eq" }),
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../lib/bullhorn-auth.js", () => ({
  firmContext: state.firmContext,
  getFirmBullhornHealthStatus: async (firmId: string) => {
    state.healthCalls += 1;
    state.lastFirmId = firmId;
    if (state.healthError) throw state.healthError;
    return state.health;
  },
}));

vi.mock("../lib/entitlements.js", () => {
  class FirmNotEntitledError extends Error {
    readonly statusCode = 402;
    readonly firmId: string;
    readonly entitlementStatus: string;
    constructor(firmId: string, entitlementStatus: string) {
      super(`not entitled: ${entitlementStatus}`);
      this.name = "FirmNotEntitledError";
      this.firmId = firmId;
      this.entitlementStatus = entitlementStatus;
    }
  }
  return {
    FirmNotEntitledError,
    assertFirmEntitled: async () => {
      if (state.entitledError) throw state.entitledError;
    },
  };
});

import { FirmNotEntitledError } from "../lib/entitlements.js";
import {
  attachFirmContext,
  bearerAuth,
  requireBullhornFirm,
  requireService,
} from "./bearer-auth.js";

const originalEnv = process.env;

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
  };
  return res as Response & { statusCode: number; payload: unknown };
}

function mockReq(opts: {
  authorization?: string;
  token?: string;
  caller?: Express.Request["caller"];
}): Request {
  return {
    headers:
      opts.authorization === undefined
        ? {}
        : { authorization: opts.authorization },
    params: opts.token === undefined ? {} : { token: opts.token },
    caller: opts.caller,
  } as Request;
}

async function runMiddleware(
  mw: (req: Request, res: Response, next: NextFunction) => unknown,
  req: Request,
) {
  const res = mockRes();
  let nextCalled = false;
  let firmIdDuringNext: string | undefined;
  await mw(req, res, () => {
    nextCalled = true;
    firmIdDuringNext = state.firmContext.getStore()?.firmId;
  });
  return {
    res,
    req,
    nextCalled,
    firmIdDuringNext,
    error: (
      res.payload as { error?: string; entitlementStatus?: string } | undefined
    )?.error,
    entitlementStatus: (
      res.payload as { entitlementStatus?: string } | undefined
    )?.entitlementStatus,
  };
}

beforeEach(() => {
  process.env = { ...originalEnv, MCP_BEARER_TOKEN: SERVICE_TOKEN };
  state.userRows = [];
  state.firmRows = [{ status: "active" }];
  state.userLookupError = null;
  state.firmLookupError = null;
  state.healthCalls = 0;
  state.lastFirmId = null;
  state.health = { ...healthy };
  state.healthError = null;
  state.entitledError = null;
});

afterEach(() => {
  process.env = originalEnv;
});

describe("bearerAuth", () => {
  it("fails closed with 503 when the service token is not configured", async () => {
    delete process.env["MCP_BEARER_TOKEN"];
    const { nextCalled, res, error } = await runMiddleware(
      bearerAuth,
      mockReq({ authorization: `Bearer ${USER_KEY}` }),
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(error).toContain("MCP_BEARER_TOKEN");
  });

  it("returns 401 when neither a header nor a path token is present", async () => {
    const { nextCalled, res, error } = await runMiddleware(
      bearerAuth,
      mockReq({}),
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(error).toContain("Missing credentials");
  });

  it("accepts the service token from the Authorization header without a user lookup", async () => {
    state.userLookupError = new Error("db should not be queried");
    const req = mockReq({ authorization: `Bearer   ${SERVICE_TOKEN}  ` });
    const { nextCalled, res } = await runMiddleware(bearerAuth, req);
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(req.caller).toEqual({ kind: "service" });
  });

  it("accepts the service token from the /mcp/:token path", async () => {
    state.userLookupError = new Error("db should not be queried");
    const req = mockReq({ token: SERVICE_TOKEN });
    const { nextCalled } = await runMiddleware(bearerAuth, req);
    expect(nextCalled).toBe(true);
    expect(req.caller).toEqual({ kind: "service" });
  });

  it("prefers an Authorization header over a path token", async () => {
    state.userRows = [{ id: "user-1", firmId: "firm-1" }];
    const req = mockReq({
      authorization: `Bearer ${USER_KEY}`,
      token: SERVICE_TOKEN,
    });
    const { nextCalled } = await runMiddleware(bearerAuth, req);
    expect(nextCalled).toBe(true);
    expect(req.caller).toEqual({
      kind: "user",
      userId: "user-1",
      firmId: "firm-1",
    });
  });

  it("does not fall through to the path token when the header is present but wrong", async () => {
    const req = mockReq({
      authorization: "Bearer not-the-service-token",
      token: SERVICE_TOKEN,
    });
    const { nextCalled, res, error } = await runMiddleware(bearerAuth, req);
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(error).toBe("Invalid token");
    expect(req.caller).toBeUndefined();
  });

  it("binds a portal user api key, including a user with no firm", async () => {
    state.userRows = [{ id: "user-2", firmId: null }];
    const req = mockReq({ token: USER_KEY });
    const { nextCalled } = await runMiddleware(bearerAuth, req);
    expect(nextCalled).toBe(true);
    expect(req.caller).toEqual({
      kind: "user",
      userId: "user-2",
      firmId: null,
    });
  });

  it("returns 401 when the user lookup throws, instead of treating the key as valid", async () => {
    state.userLookupError = new Error("connection reset");
    const { nextCalled, res, error } = await runMiddleware(
      bearerAuth,
      mockReq({ authorization: `Bearer ${USER_KEY}` }),
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(error).toBe("Invalid token");
  });

  it("rejects a different-length token without throwing", async () => {
    const { nextCalled, res } = await runMiddleware(
      bearerAuth,
      mockReq({ authorization: "Bearer x" }),
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});

describe("requireService", () => {
  it("allows only a service caller", () => {
    const service = mockReq({ caller: { kind: "service" } });
    const allowed = runMiddleware(requireService, service);
    return expect(allowed).resolves.toMatchObject({ nextCalled: true });
  });

  it("rejects a user api key and a missing caller with 403", async () => {
    for (const caller of [
      undefined,
      { kind: "user" as const, userId: "user-1", firmId: "firm-1" },
    ]) {
      const { nextCalled, res, error } = await runMiddleware(
        requireService,
        mockReq({ caller }),
      );
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(403);
      expect(error).toContain("service");
    }
  });
});

describe("requireBullhornFirm", () => {
  it("lets a service caller through without checking a firm", async () => {
    state.healthError = new Error("health should not be consulted");
    const { nextCalled, res } = await runMiddleware(
      requireBullhornFirm,
      mockReq({ caller: { kind: "service" } }),
    );
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(state.healthCalls).toBe(0);
  });

  it("returns 401 when the caller was never authenticated", async () => {
    const { nextCalled, res, error } = await runMiddleware(
      requireBullhornFirm,
      mockReq({}),
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(error).toContain("Authentication required");
    expect(state.healthCalls).toBe(0);
  });

  it("returns 403 when the user has no firm, including an empty firm id", async () => {
    for (const firmId of [null, ""]) {
      state.healthCalls = 0;
      const { nextCalled, res, error } = await runMiddleware(
        requireBullhornFirm,
        mockReq({ caller: { kind: "user", userId: "user-1", firmId } }),
      );
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(403);
      expect(error).toContain("not associated with a firm");
      expect(state.healthCalls).toBe(0);
    }
  });

  it("returns 403 when the caller's own firm is not connected", async () => {
    state.health = { ...healthy, connected: false, healthy: false };
    const { nextCalled, res, error } = await runMiddleware(
      requireBullhornFirm,
      mockReq({ caller: { kind: "user", userId: "user-1", firmId: "firm-1" } }),
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(error).toMatch(/not connected/i);
    expect(state.lastFirmId).toBe("firm-1");
  });

  it("returns 403 when the firm's Bullhorn token is connected but unhealthy", async () => {
    state.health = { ...healthy, healthy: false, needsReauthorization: true };
    state.firmLookupError = new Error("firm row should not be read yet");
    const { nextCalled, res, error } = await runMiddleware(
      requireBullhornFirm,
      mockReq({ caller: { kind: "user", userId: "user-1", firmId: "firm-9" } }),
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(error).toMatch(/refreshed/i);
    expect(state.lastFirmId).toBe("firm-9");
  });

  it("returns 403 when the firm row is missing or not active", async () => {
    state.firmRows = [];
    const missing = await runMiddleware(
      requireBullhornFirm,
      mockReq({ caller: { kind: "user", userId: "user-1", firmId: "firm-1" } }),
    );
    expect(missing.nextCalled).toBe(false);
    expect(missing.res.statusCode).toBe(403);
    expect(missing.error).toMatch(/suspended/i);

    state.firmRows = [{ status: "suspended" }];
    const suspended = await runMiddleware(
      requireBullhornFirm,
      mockReq({ caller: { kind: "user", userId: "user-1", firmId: "firm-1" } }),
    );
    expect(suspended.nextCalled).toBe(false);
    expect(suspended.res.statusCode).toBe(403);
  });

  it("returns the entitlement error instead of granting tool access", async () => {
    state.entitledError = new FirmNotEntitledError("firm-1", "past_due");
    const { nextCalled, res, error, entitlementStatus } = await runMiddleware(
      requireBullhornFirm,
      mockReq({ caller: { kind: "user", userId: "user-1", firmId: "firm-1" } }),
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(402);
    expect(error).toContain("past_due");
    expect(entitlementStatus).toBe("past_due");
  });

  it("returns 500 when firm authorization cannot be verified", async () => {
    state.healthError = new Error("timeout");
    const healthDown = await runMiddleware(
      requireBullhornFirm,
      mockReq({ caller: { kind: "user", userId: "user-1", firmId: "firm-1" } }),
    );
    expect(healthDown.nextCalled).toBe(false);
    expect(healthDown.res.statusCode).toBe(500);
    expect(healthDown.error).toContain("Could not verify");

    state.healthError = null;
    state.entitledError = new Error("billing lookup failed");
    const billingDown = await runMiddleware(
      requireBullhornFirm,
      mockReq({ caller: { kind: "user", userId: "user-1", firmId: "firm-1" } }),
    );
    expect(billingDown.nextCalled).toBe(false);
    expect(billingDown.res.statusCode).toBe(500);
  });

  it("allows an active, connected, entitled firm user", async () => {
    const { nextCalled, res } = await runMiddleware(
      requireBullhornFirm,
      mockReq({ caller: { kind: "user", userId: "user-1", firmId: "firm-1" } }),
    );
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(state.lastFirmId).toBe("firm-1");
    expect(state.healthCalls).toBe(1);
  });
});

describe("attachFirmContext", () => {
  it("runs a firm user inside that firm's context", async () => {
    const { nextCalled, firmIdDuringNext } = await runMiddleware(
      attachFirmContext,
      mockReq({ caller: { kind: "user", userId: "user-1", firmId: "firm-1" } }),
    );
    expect(nextCalled).toBe(true);
    expect(firmIdDuringNext).toBe("firm-1");
    expect(state.firmContext.getStore()).toBeUndefined();
  });

  it("does not bind a firm context for service callers or users without a firm", async () => {
    const cases = [
      mockReq({ caller: { kind: "service" } }),
      mockReq({ caller: { kind: "user", userId: "user-1", firmId: null } }),
      mockReq({}),
    ];
    for (const req of cases) {
      const { nextCalled, firmIdDuringNext } = await runMiddleware(
        attachFirmContext,
        req,
      );
      expect(nextCalled).toBe(true);
      expect(firmIdDuringNext).toBeUndefined();
    }
  });
});
