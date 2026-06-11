import { Router, type IRouter, Request, Response } from "express";
import { randomBytes } from "node:crypto";
import {
  getAuthorizeUrl,
  completeAuthorization,
  isConnected,
} from "../lib/bullhorn-auth.js";
import { bearerAuth } from "../middlewares/bearer-auth.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

function rememberState(state: string): void {
  const now = Date.now();
  for (const [key, expires] of pendingStates) {
    if (expires <= now) {
      pendingStates.delete(key);
    }
  }
  pendingStates.set(state, now + STATE_TTL_MS);
}

function consumeState(state: string): boolean {
  const expires = pendingStates.get(state);
  if (expires === undefined) {
    return false;
  }
  pendingStates.delete(state);
  return expires > Date.now();
}

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

router.get("/login", bearerAuth, async (_req: Request, res: Response) => {
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

router.get("/callback", async (req: Request, res: Response) => {
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
          "This authorization link is invalid or has expired. Please start again from the Connect Bullhorn login link.",
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

router.get("/status", bearerAuth, async (_req: Request, res: Response) => {
  try {
    const connected = await isConnected();
    res.json({ connected });
  } catch (err) {
    logger.error({ err }, "Bullhorn status check failed");
    res.status(500).json({ error: "Could not determine connection status" });
  }
});

export default router;
