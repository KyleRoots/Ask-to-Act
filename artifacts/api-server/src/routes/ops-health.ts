/**
 * Internal ops health endpoint.
 * Auth: Bearer MCP_BEARER_TOKEN or OPS_HEALTH_SECRET (never public).
 *
 * GET /api/internal/ops-health
 * GET /api/internal/ops-health?alert=1  — also run maybe-notify
 */
import { timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { evaluateOpsHealthFromDb } from "../lib/ops-health.js";
import { maybeNotifyOpsAlert } from "../lib/ops-alerts.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

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

function requireOpsHealthAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const provided = extractBearer(req);
  if (!provided) {
    res.status(401).json({
      error: "Missing Authorization: Bearer <OPS_HEALTH_SECRET|MCP_BEARER_TOKEN>",
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

  res.status(403).json({ error: "Forbidden: invalid ops health credentials" });
}

router.get(
  "/internal/ops-health",
  requireOpsHealthAuth,
  async (req, res) => {
    try {
      const alert =
        req.query["alert"] === "1" ||
        req.query["alert"] === "true" ||
        req.query["alert"] === "yes";

      const report = await evaluateOpsHealthFromDb();
      let delivery = null;
      if (alert) {
        delivery = await maybeNotifyOpsAlert(report);
      }

      const httpStatus =
        report.status === "critical" ? 503 : report.status === "warn" ? 200 : 200;

      res.status(httpStatus).json({
        ...report,
        delivery,
      });
    } catch (err) {
      logger.error({ err }, "ops-health check failed");
      res.status(500).json({
        status: "critical",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

export default router;
