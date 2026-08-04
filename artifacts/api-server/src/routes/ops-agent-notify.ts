/**
 * Internal ops agent lifecycle notify.
 * Auth: Bearer MCP_BEARER_TOKEN or OPS_HEALTH_SECRET (same as ops-health).
 *
 * POST /api/internal/ops-agent-notify
 * Body: { phase: "started"|"completed"|"failed", summary: string, details?: string, fingerprint?: string }
 */
import { Router, type IRouter } from "express";
import {
  notifyOpsAgent,
  parseOpsAgentNotifyBody,
} from "../lib/ops-agent-notify.js";
import { requireOpsInternalAuth } from "../middlewares/ops-internal-auth.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

router.post(
  "/internal/ops-agent-notify",
  requireOpsInternalAuth,
  async (req, res) => {
    try {
      const parsed = parseOpsAgentNotifyBody(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error });
        return;
      }

      const result = await notifyOpsAgent(parsed.data);
      res.status(200).json(result);
    } catch (err) {
      logger.error({ err }, "ops-agent-notify failed");
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

export default router;
