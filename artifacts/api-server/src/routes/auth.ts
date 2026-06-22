import { Router, type IRouter, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import {
  getAuthorizeUrl,
  completeAuthorization,
  completeUserEnrollment,
  connectHeadless,
  isConnected,
} from "../lib/bullhorn-auth.js";
import { rememberState, consumeState, userIdFromState } from "../lib/oauth-state.js";
import { bearerAuth } from "../middlewares/bearer-auth.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, message: string): string {
  const t = escapeHtml(title);
  const m = escapeHtml(message);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${t}</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1020;color:#e8ecf3;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}main{max-width:520px;padding:40px;text-align:center}h1{font-size:22px;margin:0 0 12px}p{font-size:15px;line-height:1.6;color:#aab4c5;margin:0}</style></head><body><main><h1>${t}</h1><p>${m}</p></main></body></html>`;
}

router.get("/auth/bullhorn/login", bearerAuth, async (_req: Request, res: Response) => {
  try {
    const state = randomBytes(16).toString("hex");
    rememberState(state);
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

  if (typeof state !== "string" || !consumeState(state)) {
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
      res.send(
        page(
          "Bullhorn account connected",
          "Your personal Bullhorn account is now linked. You can close this window — the AI connector will use your account for all write operations.",
        ),
      );
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
    await completeAuthorization(code);
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

router.post(
  "/auth/bullhorn/connect",
  bearerAuth,
  async (_req: Request, res: Response) => {
    try {
      const { restUrl } = await connectHeadless();
      logger.info({ restUrl }, "Bullhorn: headless connect succeeded");
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
