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

function enrollSuccessPage(mcpUrl: string, portalUrl: string): string {
  const safeUrl = escapeHtml(mcpUrl);
  const safePortal = escapeHtml(portalUrl);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bullhorn Connected — AskToAct</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0b1020;color:#e8ecf3;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
main{max-width:540px;width:100%}
.logo{display:flex;align-items:center;gap:10px;margin-bottom:28px}
.logo-text{font-size:18px;font-weight:800;letter-spacing:-0.02em;color:#f8fafc}
.logo-text span{color:#38BDF8}
.card{background:#141927;border:1px solid #1e2a3a;border-radius:20px;padding:36px}
.icon{width:44px;height:44px;background:rgba(16,185,129,.15);border:1px solid rgba(52,211,153,.2);border-radius:13px;display:flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:18px}
h1{font-size:22px;font-weight:800;color:#f8fafc;margin-bottom:8px;letter-spacing:-0.02em}
.subtitle{font-size:14px;color:#6B7A99;line-height:1.65;margin-bottom:28px}
.url-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.12em;color:#38bdf8;margin-bottom:10px}
.url-box{background:#0f1622;border:1px solid #1e2a3a;border-radius:12px;padding:14px 18px;display:flex;align-items:center;gap:12px;margin-bottom:28px}
.url-text{flex:1;font-size:12px;font-family:monospace;color:#94a3b8;word-break:break-all;line-height:1.5}
.copy-btn{flex-shrink:0;padding:8px 16px;background:rgba(79,70,229,.15);color:#818CF8;border:1px solid rgba(129,140,248,.3);border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
.copy-btn:hover{background:rgba(79,70,229,.25)}
.copy-btn.ok{background:rgba(16,185,129,.15);color:#34D399;border-color:rgba(52,211,153,.3)}
.steps-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.12em;color:#64748b;margin-bottom:14px}
.steps{display:flex;flex-direction:column;gap:10px;margin-bottom:28px}
.step{display:flex;gap:12px;align-items:flex-start}
.num{width:22px;height:22px;border-radius:50%;background:#1e3a5f;font-size:12px;font-weight:700;color:#38bdf8;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
.step-text{font-size:13px;color:#cbd5e1;line-height:1.6}
.step-text strong{color:#f8fafc}
hr{border:none;border-top:1px solid #1e2a3a;margin-bottom:20px}
.portal-link{display:block;text-align:center;padding:14px;background:linear-gradient(135deg,#4F46E5,#0EA5E9);border-radius:12px;color:#fff;font-size:15px;font-weight:700;text-decoration:none;letter-spacing:-0.01em}
.portal-link:hover{opacity:.9}
</style>
</head>
<body>
<main>
  <div class="logo">
    <svg width="28" height="28" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#4338CA"/><stop offset="55%" stop-color="#4F46E5"/><stop offset="100%" stop-color="#0EA5E9"/></linearGradient></defs><rect width="48" height="48" rx="13" fill="url(#g)"/><path d="M11 5 C11 3.3 12.3 2 14 2 L34 2 C35.7 2 37 3.3 37 5 L37 27 C37 28.7 35.7 30 34 30 L27.5 30 L24 36.5 L20.5 30 L14 30 C12.3 30 11 28.7 11 27 Z" fill="white" fill-opacity="0.97"/><line x1="15.5" y1="16" x2="29.5" y2="16" stroke="#4338CA" stroke-width="3" stroke-linecap="round"/><polyline points="25,11 31,16 25,21" fill="none" stroke="#4338CA" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span class="logo-text">Ask<span>To</span>Act</span>
  </div>
  <div class="card">
    <div class="icon">✅</div>
    <h1>Bullhorn connected!</h1>
    <p class="subtitle">Your Bullhorn account is linked. Copy the URL below and paste it into ChatGPT, Claude, or Gemini to start using AI inside Bullhorn.</p>

    <p class="url-label">Your connector URL</p>
    <div class="url-box">
      <span class="url-text" id="u">${safeUrl}</span>
      <button class="copy-btn" id="cb" onclick="copy()">Copy</button>
    </div>

    <p class="steps-label">Connect to your AI tool</p>
    <div class="steps">
      <div class="step"><div class="num">1</div><div class="step-text">Open <strong>ChatGPT</strong> → Settings → Connectors and click <strong>Add connector</strong></div></div>
      <div class="step"><div class="num">2</div><div class="step-text">Paste your connector URL above and click <strong>Connect</strong>, then <strong>Always allow</strong></div></div>
      <div class="step"><div class="num">3</div><div class="step-text">Try asking: <strong>"Show me my open jobs in Bullhorn"</strong> — you're live!</div></div>
    </div>

    <hr>
    <a href="${safePortal}" class="portal-link">Go to your portal →</a>
  </div>
</main>
<script>
function copy(){
  navigator.clipboard.writeText(document.getElementById('u').textContent||'').then(function(){
    var b=document.getElementById('cb');
    b.textContent='Copied!';b.classList.add('ok');
    setTimeout(function(){b.textContent='Copy';b.classList.remove('ok');},2000);
  }).catch(function(){
    var b=document.getElementById('cb');
    b.textContent='Copy failed';
    setTimeout(function(){b.textContent='Copy';},2000);
  });
}
</script>
</body>
</html>`;
}

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

      const baseUrl = getBaseUrl();
      const [userRow] = await db
        .select({ apiKey: usersTable.apiKey })
        .from(usersTable)
        .where(eq(usersTable.id, userId));

      const mcpUrl = userRow?.apiKey
        ? `${baseUrl}/api/mcp/${userRow.apiKey}`
        : `${baseUrl}/api/mcp/<your-api-key>`;

      res.set("Cache-Control", "no-store");
      res.send(enrollSuccessPage(mcpUrl, `${baseUrl}/portal/`));
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
