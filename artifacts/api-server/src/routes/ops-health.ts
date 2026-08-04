/**
 * Internal ops health endpoint.
 * Auth: Bearer MCP_BEARER_TOKEN or OPS_HEALTH_SECRET (never public).
 *
 * GET /api/internal/ops-health
 * GET /api/internal/ops-health?alert=1  — also run maybe-notify
 */
import { Router, type IRouter } from "express";
import { evaluateOpsHealthFromDb } from "../lib/ops-health.js";
import { maybeNotifyOpsAlert } from "../lib/ops-alerts.js";
import { requireOpsInternalAuth } from "../middlewares/ops-internal-auth.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

router.get(
  "/internal/ops-health",
  requireOpsInternalAuth,
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
