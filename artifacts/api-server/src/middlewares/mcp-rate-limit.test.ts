import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { createHash } from "node:crypto";
import { mcpRateLimitKey } from "./mcp-rate-limit.js";

function reqWith(opts: { auth?: string; path?: string; ip?: string }): Request {
  return {
    headers: opts.auth ? { authorization: opts.auth } : {},
    path: opts.path ?? "/",
    ip: opts.ip ?? "203.0.113.5",
  } as unknown as Request;
}

const tokKey = (t: string) =>
  "mcp-tok:" + createHash("sha256").update(t).digest("hex");

describe("mcpRateLimitKey", () => {
  it("keys by the bearer token (hashed), never the raw secret", () => {
    const key = mcpRateLimitKey(
      reqWith({ auth: "Bearer secret-abc", ip: "1.2.3.4" }),
    );
    expect(key).toBe(tokKey("secret-abc"));
    expect(key).not.toContain("secret-abc");
  });

  it("gives the SAME token the same key regardless of source IP", () => {
    const a = mcpRateLimitKey(reqWith({ auth: "Bearer T", ip: "1.1.1.1" }));
    const b = mcpRateLimitKey(reqWith({ auth: "Bearer T", ip: "2.2.2.2" }));
    expect(a).toBe(b);
  });

  it("gives DIFFERENT tokens different keys from the same shared IP", () => {
    const a = mcpRateLimitKey(reqWith({ auth: "Bearer userA", ip: "9.9.9.9" }));
    const b = mcpRateLimitKey(reqWith({ auth: "Bearer userB", ip: "9.9.9.9" }));
    expect(a).not.toBe(b);
  });

  it("extracts the token from the /mcp/:token path form", () => {
    const key = mcpRateLimitKey(reqWith({ path: "/path-token-123" }));
    expect(key).toBe(tokKey("path-token-123"));
  });

  it("falls back to an IP key when no token is present", () => {
    const key = mcpRateLimitKey(reqWith({ path: "/", ip: "203.0.113.7" }));
    expect(key.startsWith("mcp-ip:")).toBe(true);
    expect(key).not.toContain("mcp-tok:");
  });
});
