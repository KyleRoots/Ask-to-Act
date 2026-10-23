import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

/**
 * Portal identity bridge. A wrong bind here shows one firm another firm's
 * people and usage, so ambiguity and missing Clerk data must fail closed.
 */

type UserRow = {
  id: string;
  name: string;
  email: string | null;
  role: string;
  firmId: string | null;
};

type ClerkEmail = { id: string; emailAddress: string | null };

const state = vi.hoisted(() => ({
  userId: null as string | null,
  clerkError: null as Error | null,
  primaryEmailAddressId: "primary" as string | null,
  emailAddresses: [] as ClerkEmail[],
  rows: [] as UserRow[],
  sqlValues: [] as unknown[],
}));

vi.mock("@clerk/express", () => ({
  getAuth: () => ({ userId: state.userId }),
  clerkClient: {
    users: {
      getUser: async () => {
        if (state.clerkError) throw state.clerkError;
        return {
          primaryEmailAddressId: state.primaryEmailAddressId,
          emailAddresses: state.emailAddresses,
        };
      },
    },
  },
}));

vi.mock("@workspace/db", () => ({
  usersTable: {
    id: "id",
    name: "name",
    email: "email",
    role: "role",
    firmId: "firmId",
  },
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async (n: number) => state.rows.slice(0, n),
        }),
      }),
    }),
  },
}));

vi.mock("drizzle-orm", () => ({
  sql: (_strings: TemplateStringsArray, ...values: unknown[]) => {
    state.sqlValues = values;
    return { values };
  },
}));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { requireClerkUser, requireFirmAdmin } from "./clerk-user.js";

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

async function runClerk(req: Request = {} as Request) {
  const res = mockRes();
  let nextCalled = false;
  await requireClerkUser(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);
  return {
    req,
    res,
    nextCalled,
    error: (res.payload as { error?: string } | undefined)?.error,
  };
}

beforeEach(() => {
  state.userId = "clerk-user-1";
  state.clerkError = null;
  state.primaryEmailAddressId = "primary";
  state.emailAddresses = [
    { id: "primary", emailAddress: "Admin@Firm.Example" },
  ];
  state.rows = [
    {
      id: "user-1",
      name: "Ada Admin",
      email: "admin@firm.example",
      role: "admin",
      firmId: "firm-1",
    },
  ];
  state.sqlValues = [];
});

afterEach(() => {
  state.rows = [];
});

describe("requireClerkUser", () => {
  it("returns 401 when there is no Clerk session", async () => {
    state.userId = null;
    state.clerkError = new Error("should not call Clerk");
    const { nextCalled, res, error } = await runClerk();
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(error).toBe("Not signed in");
  });

  it("returns 401 when Clerk cannot be reached", async () => {
    state.clerkError = new Error("clerk timeout");
    const { nextCalled, res, error, req } = await runClerk();
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(error).toBe("Could not resolve account");
    expect(req.portalUser).toBeUndefined();
  });

  it("returns 403 when the Clerk account has no usable email", async () => {
    state.emailAddresses = [];
    const missing = await runClerk();
    expect(missing.res.statusCode).toBe(403);
    expect(missing.error).toContain("No email");
    expect(state.sqlValues).toEqual([]);

    state.primaryEmailAddressId = "primary";
    state.emailAddresses = [
      { id: "other", emailAddress: "real@example.com" },
      { id: "primary", emailAddress: "   " },
    ];
    const blankPrimary = await runClerk();
    expect(blankPrimary.nextCalled).toBe(false);
    expect(blankPrimary.res.statusCode).toBe(403);
    expect(blankPrimary.error).toContain("No email");
    expect(state.sqlValues).toEqual([]);
  });

  it("matches the primary email, trimmed and lowercased", async () => {
    state.emailAddresses = [
      { id: "other", emailAddress: "other.person@example.com" },
      { id: "primary", emailAddress: "  Admin@Firm.Example  " },
    ];
    const { nextCalled, req } = await runClerk();
    expect(state.sqlValues[1]).toBe("admin@firm.example");
    expect(nextCalled).toBe(true);
    expect(req.portalUser).toEqual({
      id: "user-1",
      name: "Ada Admin",
      email: "admin@firm.example",
      role: "admin",
      firmId: "firm-1",
    });
  });

  it("falls back to the first address when the primary id is missing", async () => {
    state.primaryEmailAddressId = "missing";
    state.emailAddresses = [{ id: "first", emailAddress: "First@Example.com" }];
    state.rows = [
      {
        id: "user-9",
        name: "First",
        email: null,
        role: "recruiter",
        firmId: "firm-9",
      },
    ];
    const { nextCalled, req } = await runClerk();
    expect(state.sqlValues[1]).toBe("first@example.com");
    expect(nextCalled).toBe(true);
    expect(req.portalUser).toMatchObject({
      id: "user-9",
      email: "first@example.com",
      role: "recruiter",
      firmId: "firm-9",
    });
  });

  it("returns 403 when the email is not provisioned", async () => {
    state.rows = [];
    const { nextCalled, res, error, req } = await runClerk();
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(error).toContain("not provisioned");
    expect(req.portalUser).toBeUndefined();
  });

  it("returns 409 and does not bind when the email matches more than one user", async () => {
    state.rows = [
      {
        id: "user-a",
        name: "A",
        email: "a@example.com",
        role: "recruiter",
        firmId: "firm-a",
      },
      {
        id: "user-b",
        name: "B",
        email: "A@example.com",
        role: "admin",
        firmId: "firm-b",
      },
    ];
    const { nextCalled, res, error, req } = await runClerk();
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(409);
    expect(error).toContain("more than one account");
    expect(req.portalUser).toBeUndefined();
  });
});

describe("requireFirmAdmin", () => {
  function run(role: string | undefined) {
    const res = mockRes();
    let nextCalled = false;
    const req = {
      portalUser:
        role === undefined
          ? undefined
          : {
              id: "user-1",
              name: "Pat",
              email: "pat@example.com",
              role,
              firmId: "firm-1",
            },
    } as Request;
    requireFirmAdmin(req, res, () => {
      nextCalled = true;
    });
    return {
      nextCalled,
      statusCode: res.statusCode,
      error: (res.payload as { error?: string } | undefined)?.error,
    };
  }

  it("allows an admin and rejects everyone else", () => {
    expect(run("admin")).toMatchObject({ nextCalled: true, statusCode: 200 });

    for (const role of ["recruiter", "Admin", undefined]) {
      const result = run(role);
      expect(result.nextCalled).toBe(false);
      expect(result.statusCode).toBe(403);
      expect(result.error).toContain("firm administrators");
    }
  });
});
