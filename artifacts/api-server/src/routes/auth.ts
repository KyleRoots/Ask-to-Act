import { Router, type IRouter, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import {
  getAuthorizeUrl,
  completeAuthorization,
  completeUserEnrollment,
  connectHeadless,
  isConnected,
} from "../lib/bullhorn-auth.js";
import { rememberState, consumeState, userIdFromState, peekFirmId } from "../lib/oauth-state.js";
import { bearerAuth, requireService } from "../middlewares/bearer-auth.js";
import { logger } from "../lib/logger.js";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getBaseUrl } from "../lib/getBaseUrl.js";
import { page } from "../lib/html.js";
import { connectorSetupPage } from "./users.js";

const router: IRouter = Router();


/**
 * GET /auth/bullhorn/login
 * Initiates the interactive Bullhorn OAuth flow. Service token only.
 * Optional query param ?firmId=<id> binds the resulting token to a specific firm.
 */
router.get("/auth/bullhorn/login", bearerAuth, requireService, async (req: Request, res: Response) => {
  try {
    const firmId = typeof req.query["firmId"] === "string" ? req.query["firmId"] : undefined;
    const state = randomBytes(16).toString("hex");
    rememberState(state, firmId);
    const url = await getAuthorizeUrl(state);
    res.redirect(url);
  } catch (err) {
    logger.error({ err }, "Bullhorn login redirect failed");
    res
      .status(500)
      .send(
        page(
          "Could not start Bullhorn login",
          "The server could not build the Bullhorn authorization link. Check that BULLHORN_CLIENT_ID and BULLHORN_REDIRECT_URI are configured correctly.",
        ),
      );
  }
});

/**
 * Shared OAuth callback for both the service-account flow and per-user
 * enrollment. The `state` parameter encodes the flow:
 *   - Service account: plain random hex  (rememberState / consumeState)
 *   - User enrollment: "user:{userId}:{random}"  (same map, userId embedded)
 *
 * Both flows share the same BULLHORN_REDIRECT_URI so only one URI needs to be
 * registered with Bullhorn Support.
 */
router.get("/auth/bullhorn/callback", async (req: Request, res: Response) => {
  const { code, state, error, error_description } = req.query;

  if (typeof error === "string") {
    const detail = typeof error_description === "string" ? error_description : error;
    logger.warn({ error: detail }, "Bullhorn callback returned an error");
    res
      .status(400)
      .send(page("Bullhorn authorization failed", `Bullhorn reported: ${detail}`));
    return;
  }

  if (typeof state !== "string") {
    res
      .status(400)
      .send(
        page(
          "Authorization link expired",
          "This authorization link is invalid or has expired. Please start again.",
        ),
      );
    return;
  }

  // Peek at firmId BEFORE consuming the state (consumeState deletes the entry).
  const firmId = peekFirmId(state) ?? undefined;

  if (!consumeState(state)) {
    res
      .status(400)
      .send(
        page(
          "Authorization link expired",
          "This authorization link is invalid or has expired. Please start again.",
        ),
      );
    return;
  }

  if (typeof code !== "string" || code.length === 0) {
    res
      .status(400)
      .send(page("Missing authorization code", "Bullhorn did not return an authorization code."));
    return;
  }

  const userId = userIdFromState(state);

  if (userId) {
    try {
      await completeUserEnrollment(userId, code);
      logger.info({ userId }, "Bullhorn: user enrollment complete via shared callback");

      // One-time enrollment token is now spent — clear it so the link can't be reused.
      await db
        .update(usersTable)
        .set({ enrollToken: null, enrollTokenExpiresAt: null, updatedAt: new Date() })
        .where(eq(usersTable.id, userId));

      const baseUrl = getBaseUrl();
      const [userRow] = await db
        .select({ apiKey: usersTable.apiKey, name: usersTable.name })
        .from(usersTable)
        .where(eq(usersTable.id, userId));

      const mcpUrl = userRow?.apiKey
        ? `${baseUrl}/api/mcp/${userRow.apiKey}`
        : null;

      res.set("Cache-Control", "no-store");
      res.send(connectorSetupPage(userRow?.name ?? "there", mcpUrl, false));
    } catch (err) {
      logger.error({ err, userId }, "User enrollment code exchange failed");
      res
        .status(500)
        .send(
          page(
            "Could not complete enrollment",
            "The authorization code could not be exchanged. Please try enrolling again.",
          ),
        );
    }
    return;
  }

  try {
    await completeAuthorization(code, firmId);
    res.send(
      page(
        "Bullhorn connected",
        "Your Bullhorn account is now connected. You can close this window — the MCP server is ready to use.",
      ),
    );
  } catch (err) {
    logger.error({ err }, "Bullhorn authorization exchange failed");
    res
      .status(500)
      .send(
        page(
          "Could not complete Bullhorn connection",
          "The authorization code could not be exchanged for a session. Please try connecting again.",
        ),
      );
  }
});

router.get("/auth/bullhorn/status", bearerAuth, async (_req: Request, res: Response) => {
  try {
    const connected = await isConnected();
    res.json({ connected });
  } catch (err) {
    logger.error({ err }, "Bullhorn status check failed");
    res.status(500).json({ error: "Could not determine connection status" });
  }
});

/**
 * POST /auth/bullhorn/connect
 * Headless service-account connect using stored env-var credentials. Service token only.
 * Optional body/query param firmId binds the token to a specific firm.
 */
router.post(
  "/auth/bullhorn/connect",
  bearerAuth,
  requireService,
  async (req: Request, res: Response) => {
    try {
      const firmId =
        (typeof req.body?.firmId === "string" ? req.body.firmId : undefined) ??
        (typeof req.query["firmId"] === "string" ? req.query["firmId"] : undefined);
      const { restUrl } = await connectHeadless(firmId);
      logger.info({ restUrl, firmId }, "Bullhorn: headless connect succeeded");
      res.json({ connected: true, restUrl });
    } catch (err) {
      logger.error({ err }, "Bullhorn headless connect failed");
      res
        .status(502)
        .json({ connected: false, error: (err as Error).message });
    }
  },
);

export default router;
