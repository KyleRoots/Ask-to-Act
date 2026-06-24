import { Router, type IRouter, type Request, type Response } from "express";
import { db, firmsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getBaseUrl } from "../lib/getBaseUrl.js";
import {
  requireClerkUser,
  requireFirmAdmin,
} from "../middlewares/clerk-user.js";
import { buildFirmUsageDetail } from "../lib/usage-report.js";

const router: IRouter = Router();

/**
 * GET /api/portal/me
 * Clerk-authenticated. Returns the signed-in user's AskToAct profile so the
 * portal can tailor the UI (e.g. show admin-only views to firm admins).
 */
router.get(
  "/portal/me",
  requireClerkUser,
  async (req: Request, res: Response) => {
    const u = req.portalUser!;

    const [firmName, userRow] = await Promise.all([
      u.firmId
        ? db
            .select({ name: firmsTable.name })
            .from(firmsTable)
            .where(eq(firmsTable.id, u.firmId))
            .then((rows) => rows[0]?.name ?? null)
        : Promise.resolve(null),
      db
        .select({ apiKey: usersTable.apiKey, refreshToken: usersTable.refreshToken })
        .from(usersTable)
        .where(eq(usersTable.id, u.id))
        .then((rows) => rows[0] ?? null),
    ]);

    const enrolled = userRow?.refreshToken != null;
    const mcpUrl = enrolled && userRow?.apiKey
      ? `${getBaseUrl()}/api/mcp/${userRow.apiKey}`
      : null;

    res.set("Cache-Control", "no-store");
    res.json({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      firmId: u.firmId,
      firmName,
      enrolled,
      mcpUrl,
    });
  },
);

/**
 * GET /api/portal/team-usage?year=YYYY&month=M
 * Clerk-authenticated, firm-admin only. Per-user, per-tool usage breakdown
 * scoped to the caller's OWN firm. Defaults to the current UTC month.
 */
router.get(
  "/portal/team-usage",
  requireClerkUser,
  requireFirmAdmin,
  async (req: Request, res: Response) => {
    const firmId = req.portalUser!.firmId;
    if (!firmId) {
      res.status(400).json({ error: "Your account is not linked to a firm." });
      return;
    }

    const now = new Date();
    const year = Number(req.query.year) || now.getUTCFullYear();
    const month = Number(req.query.month) || now.getUTCMonth() + 1;

    const detail = await buildFirmUsageDetail(firmId, year, month);
    res.json({ year, month, ...detail });
  },
);

export default router;
