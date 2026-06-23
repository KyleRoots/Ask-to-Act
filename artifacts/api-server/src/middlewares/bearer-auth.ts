import { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";

export type CallerIdentity =
  | { kind: "service" }
  | { kind: "user"; userId: string };

declare global {
  namespace Express {
    interface Request {
      caller?: CallerIdentity;
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function extractProvidedToken(req: Request): string | null {
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }

  const pathToken = req.params["token"];
  if (typeof pathToken === "string" && pathToken.length > 0) {
    return pathToken;
  }

  const queryToken = req.query["key"] ?? req.query["token"];
  if (typeof queryToken === "string" && queryToken.length > 0) {
    return queryToken;
  }

  return null;
}

export async function bearerAuth(req: Request, res: Response, next: NextFunction) {
  const serviceToken = process.env["MCP_BEARER_TOKEN"];

  if (!serviceToken) {
    res.status(503).json({
      error: "Server misconfiguration: MCP_BEARER_TOKEN is not set",
    });
    return;
  }

  const provided = extractProvidedToken(req);
  if (!provided) {
    res.status(401).json({
      error:
        "Missing credentials. Provide the token via 'Authorization: Bearer <token>' header, a '/mcp/<token>' path, or a '?key=<token>' query parameter.",
    });
    return;
  }

  if (safeEqual(provided, serviceToken)) {
    req.caller = { kind: "service" };
    next();
    return;
  }

  try {
    const rows = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.apiKey, provided))
      .limit(1);
    if (rows[0]) {
      req.caller = { kind: "user", userId: rows[0].id };
      next();
      return;
    }
  } catch (err) {
    logger.warn({ err }, "bearerAuth: DB lookup failed");
  }

  res.status(401).json({ error: "Invalid token" });
}

/**
 * Gate that restricts a route to the service token only (firm/user
 * administration). Must run AFTER bearerAuth, which populates req.caller.
 * A valid user API key is rejected with 403 so a recruiter's key can never
 * reach firm-management endpoints.
 */
export function requireService(req: Request, res: Response, next: NextFunction) {
  if (req.caller?.kind !== "service") {
    res.status(403).json({
      error:
        "Forbidden: this endpoint requires the service (admin) token. User API keys are not permitted here.",
    });
    return;
  }
  next();
}
