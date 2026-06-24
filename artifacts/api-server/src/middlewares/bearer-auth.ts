import { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { getBullhornFirmId } from "../lib/bullhorn-auth.js";

export type CallerIdentity =
  | { kind: "service" }
  | { kind: "user"; userId: string; firmId: string | null };

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
        "Missing credentials. Provide the token via an 'Authorization: Bearer <token>' header or a '/mcp/<token>' path.",
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
      .select({ id: usersTable.id, firmId: usersTable.firmId })
      .from(usersTable)
      .where(eq(usersTable.apiKey, provided))
      .limit(1);
    if (rows[0]) {
      req.caller = { kind: "user", userId: rows[0].id, firmId: rows[0].firmId ?? null };
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

/**
 * Tenant-isolation gate for Bullhorn read endpoints.
 * Must run AFTER bearerAuth.
 *
 * - Service callers bypass: they administer the connection itself.
 * - If the shared Bullhorn token has a firmId set, user callers must belong to
 *   that same firm. A mismatch returns 403 so a user from Firm B cannot read
 *   data belonging to Firm A's Bullhorn account.
 * - If no firmId is bound to the token (single-tenant / legacy deployment),
 *   all authenticated callers are permitted and a warning is logged once.
 */
let _firmWarningLogged = false;

export async function requireBullhornFirm(req: Request, res: Response, next: NextFunction) {
  if (req.caller?.kind === "service") {
    next();
    return;
  }

  if (req.caller?.kind !== "user") {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  try {
    const boundFirmId = await getBullhornFirmId();

    if (!boundFirmId) {
      if (!_firmWarningLogged) {
        logger.warn(
          "Bullhorn token has no firmId bound — user read access is blocked until the Bullhorn " +
            "connection is re-authorised with a firmId. A service-token caller must re-run " +
            "Bullhorn connect/login with ?firmId=<id> to lift this block.",
        );
        _firmWarningLogged = true;
      }
      res.status(403).json({
        error:
          "Bullhorn workspace is not yet bound to a firm. An administrator must re-authorise the " +
          "Bullhorn connection (supply firmId) before user API access can be granted.",
      });
      return;
    }

    const callerFirmId = req.caller.firmId;
    if (callerFirmId !== boundFirmId) {
      logger.warn(
        { callerFirmId, boundFirmId, userId: req.caller.userId },
        "requireBullhornFirm: caller firmId does not match Bullhorn token firmId",
      );
      res.status(403).json({
        error:
          "Forbidden: your account is not authorized to access this Bullhorn workspace.",
      });
      return;
    }

    next();
  } catch (err) {
    logger.error({ err }, "requireBullhornFirm: failed to verify firm binding");
    res.status(500).json({ error: "Could not verify firm authorization." });
  }
}
