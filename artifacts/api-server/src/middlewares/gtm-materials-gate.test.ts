import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import { gtmMaterialsGate } from "./gtm-materials-gate.js";

function mockRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    body: "",
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    type(_t: string) {
      return res;
    },
    send(body: string) {
      res.body = body;
    },
  } as Response & { statusCode: number; body: string };
  return { res, headers };
}

describe("gtmMaterialsGate", () => {
  const env = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...env };
  });

  afterEach(() => {
    process.env = env;
  });

  it("returns 404 in production when password is not configured", () => {
    process.env.NODE_ENV = "production";
    delete process.env.GTM_MATERIALS_PASSWORD;
    delete process.env.GTM_MATERIALS_PUBLIC;

    const { res, headers } = mockRes();
    let nextCalled = false;
    gtmMaterialsGate({ headers: {} } as Request, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(404);
    expect(headers["X-Robots-Tag"]).toContain("noindex");
  });

  it("requires basic auth when password is configured", () => {
    process.env.NODE_ENV = "production";
    process.env.GTM_MATERIALS_PASSWORD = "secret";
    process.env.GTM_MATERIALS_USER = "asktoact";

    const { res, headers } = mockRes();
    gtmMaterialsGate({ headers: {} } as Request, res, () => {});

    expect(res.statusCode).toBe(401);
    expect(headers["WWW-Authenticate"]).toContain("Basic");
  });

  it("allows access with valid basic auth", () => {
    process.env.NODE_ENV = "production";
    process.env.GTM_MATERIALS_PASSWORD = "secret";
    process.env.GTM_MATERIALS_USER = "asktoact";

    const token = Buffer.from("asktoact:secret").toString("base64");
    const { res } = mockRes();
    let nextCalled = false;
    gtmMaterialsGate(
      { headers: { authorization: `Basic ${token}` } } as Request,
      res,
      () => {
        nextCalled = true;
      },
    );

    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });
});
