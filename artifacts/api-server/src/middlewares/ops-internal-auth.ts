/**
 * Shared auth for internal ops endpoints (ops-health, ops-agent-notify).
 * Accepts Bearer MCP_BEARER_TOKEN or OPS_HEALTH_SECRET.
 */
import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function extractBearer(req: Request): string | null {
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }
  return null;
}

export function requireOpsInternalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const provided = extractBearer(req);
  if (!provided) {
    res.status(401).json({
      error:
        "Missing Authorization: Bearer <OPS_HEALTH_SECRET|MCP_BEARER_TOKEN>",
    });
    return;
  }

  const opsSecret = process.env["OPS_HEALTH_SECRET"]?.trim();
  const mcpToken = process.env["MCP_BEARER_TOKEN"]?.trim();

  if (opsSecret && safeEqual(provided, opsSecret)) {
    next();
    return;
  }
  if (mcpToken && safeEqual(provided, mcpToken)) {
    next();
    return;
  }

  res.status(403).json({ error: "Forbidden: invalid ops credentials" });
}
