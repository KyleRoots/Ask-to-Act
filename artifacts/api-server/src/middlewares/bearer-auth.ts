import { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { db, usersTable, firmsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { isFirmConnected, firmContext } from "../lib/bullhorn-auth.js";

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
 * - Service callers bypass: they administer the connections themselves.
 * - User callers must belong to a firm whose OWN Bullhorn workspace is connected
 *   (a token row exists for that firm) AND whose AskToAct access is active.
 *   Each firm has its own service connection, so there is no shared/global firm
 *   binding any more — the gate is purely "is THIS caller's firm connected and
 *   active?".
 */
export async function requireBullhornFirm(req: Request, res: Response, next: NextFunction) {
  if (req.caller?.kind === "service") {
    next();
    return;
  }

  if (req.caller?.kind !== "user") {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  const callerFirmId = req.caller.firmId;
  if (!callerFirmId) {
    logger.warn(
      { userId: req.caller.userId },
      "requireBullhornFirm: caller is not associated with any firm",
    );
    res.status(403).json({
      error: "Forbidden: your account is not associated with a firm.",
    });
    return;
  }

  try {
    // The caller's firm must have its own Bullhorn workspace connected.
    const connected = await isFirmConnected(callerFirmId);
    if (!connected) {
      logger.warn(
        { callerFirmId, userId: req.caller.userId },
        "requireBullhornFirm: caller's firm has no Bullhorn connection",
      );
      res.status(403).json({
        error:
          "Your firm's Bullhorn workspace is not connected yet. An administrator must complete " +
          "Bullhorn setup for your organization before you can use the AI tools.",
      });
      return;
    }

    // Lifecycle gate: a suspended or archived firm has had its access revoked,
    // so none of its users may use the AI tools — even if already enrolled.
    // Fail closed: if the firm row is missing (data drift / orphaned user) or
    // is not active, deny access rather than letting the request through.
    const [firm] = await db
      .select({ status: firmsTable.status })
      .from(firmsTable)
      .where(eq(firmsTable.id, callerFirmId))
      .limit(1);

    if (!firm || firm.status !== "active") {
      logger.warn(
        { callerFirmId, status: firm?.status ?? "missing", userId: req.caller.userId },
        "requireBullhornFirm: caller's firm is missing or not active",
      );
      res.status(403).json({
        error:
          "Forbidden: your firm's AskToAct access has been suspended. Please contact your administrator.",
      });
      return;
    }

    next();
  } catch (err) {
    logger.error({ err }, "requireBullhornFirm: failed to verify firm authorization");
    res.status(500).json({ error: "Could not verify firm authorization." });
  }
}

/**
 * Binds the AsyncLocalStorage firm context for the duration of a request so the
 * Bullhorn auth/client layer resolves the CALLER'S firm session, cache and
 * endpoints. Must run AFTER bearerAuth + requireBullhornFirm.
 *
 * For user callers, runs the downstream chain inside firmContext.run so getSession
 * (and the firm-prefixed caches) resolve to the caller's firm. Service callers
 * are left without a firm context — they administer connections and do not read
 * per-firm Bullhorn data through these tool routes (getSession fails closed).
 */
export function attachFirmContext(req: Request, res: Response, next: NextFunction) {
  if (req.caller?.kind === "user" && req.caller.firmId) {
    firmContext.run({ firmId: req.caller.firmId }, () => next());
    return;
  }
  next();
}
