import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { db, usersTable, firmsTable } from "@workspace/db";
import { and, count, eq } from "drizzle-orm";
import { bearerAuth, requireService } from "../middlewares/bearer-auth.js";
import {
  invalidateUserSession,
  enrollUserHeadless,
} from "../lib/bullhorn-auth.js";
import { stripeStorage } from "../lib/stripe/storage.js";
import { logger } from "../lib/logger.js";
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
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t}</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1020;color:#e8ecf3;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}main{max-width:520px;padding:40px;text-align:center}h1{font-size:22px;margin:0 0 12px}p{font-size:15px;line-height:1.6;color:#aab4c5;margin:0}</style></head><body><main><h1>${t}</h1><p>${m}</p></main></body></html>`;
}

/**
 * POST /api/users
 * Admin-only: creates a recruiter user and returns their API key (shown once).
 * Body: { name: string, email?: string }
 * After creation, the user enrolls their Bullhorn account at the returned enrollUrl.
 */
router.post("/users", bearerAuth, requireService, async (req: Request, res: Response) => {
  const { name, email, firmId, role } = req.body as {
    name?: string;
    email?: string;
    firmId?: string;
    role?: string;
  };

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  // If a firmId is provided, validate the firm exists and has an active subscription
  if (firmId) {
    const [firm] = await db
      .select()
      .from(firmsTable)
      .where(eq(firmsTable.id, firmId))
      .limit(1);

    if (!firm) {
      res.status(400).json({ error: `Firm '${firmId}' not found` });
      return;
    }

    const status = await stripeStorage.resolveFirmStatus(firmId);
    if (status !== "active" && status !== "trialing") {
      res.status(402).json({
        error: `Firm subscription is not active (status: ${status}). Complete checkout before adding users.`,
        subscriptionStatus: status,
        firmId,
      });
      return;
    }

    if (firm.seatLimit != null) {
      const enrolled = await stripeStorage.countFirmUsers(firmId);
      if (enrolled >= firm.seatLimit) {
        res.status(402).json({
          error: `Seat limit reached (${enrolled}/${firm.seatLimit}). Upgrade the subscription to add more users.`,
          enrolled,
          seatLimit: firm.seatLimit,
        });
        return;
      }
    }
  }

  const id = randomBytes(12).toString("hex");
  const apiKey = randomBytes(32).toString("hex");
  const enrollToken = randomBytes(32).toString("hex");
  const enrollTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const assignedRole = role === "admin" ? "admin" : "recruiter";

  try {
    await db.insert(usersTable).values({
      id,
      name: name.trim(),
      email: email?.trim().toLowerCase() ?? null,
      apiKey,
      firmId: firmId ?? null,
      role: assignedRole,
      enrollToken,
      enrollTokenExpiresAt,
    });
    logger.info({ userId: id, name: name.trim(), firmId, role: assignedRole }, "User created");
    res.status(201).json({
      id,
      name: name.trim(),
      email: email?.trim().toLowerCase() ?? null,
      apiKey,
      firmId: firmId ?? null,
      role: assignedRole,
      enrollUrl: `${getBaseUrl()}/api/auth/user/enroll?token=${enrollToken}`,
      message:
        "Store this apiKey securely — it will not be shown again. " +
        "The user must visit enrollUrl in a browser to connect their Bullhorn account before write tools will work. " +
        "The enrollment link expires in 7 days; use POST /api/users/:id/invite to issue a new one.",
    });
  } catch (err) {
    logger.error({ err }, "Failed to create user");
    res.status(500).json({ error: "Failed to create user" });
  }
});

/**
 * GET /api/users
 * Admin-only: lists all users (no apiKey or tokens exposed).
 * enrollUrl is only present when the user has a valid (non-expired) enrollment token.
 * Use POST /api/users/:id/invite to generate a fresh link.
 */
router.get("/users", bearerAuth, requireService, async (_req: Request, res: Response) => {
  try {
    const rows = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        enrolled: usersTable.refreshToken,
        enrollToken: usersTable.enrollToken,
        enrollTokenExpiresAt: usersTable.enrollTokenExpiresAt,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable);
    const now = new Date();
    res.json(
      rows.map((r) => {
        const tokenValid = r.enrollToken && r.enrollTokenExpiresAt && r.enrollTokenExpiresAt > now;
        return {
          id: r.id,
          name: r.name,
          email: r.email,
          enrolled: r.enrolled !== null,
          enrollUrl: tokenValid ? `${getBaseUrl()}/api/auth/user/enroll?token=${r.enrollToken}` : null,
          createdAt: r.createdAt,
        };
      }),
    );
  } catch (err) {
    logger.error({ err }, "Failed to list users");
    res.status(500).json({ error: "Failed to list users" });
  }
});

/**
 * PATCH /api/users/:id
 * Admin-only: updates a user's role. Accepts { role: "admin" | "recruiter" }.
 * Only the role field is settable here — name/email changes require user management UI.
 */
router.patch("/users/:id", bearerAuth, requireService, async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const { role } = req.body as { role?: string };

  if (role !== "admin" && role !== "recruiter") {
    res.status(400).json({ error: "role must be 'admin' or 'recruiter'" });
    return;
  }

  try {
    const [user] = await db
      .select({ id: usersTable.id, role: usersTable.role, firmId: usersTable.firmId })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1);

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Guard: cannot demote the last admin of a firm
    if (role === "recruiter" && user.role === "admin" && user.firmId) {
      const [{ adminCount }] = await db
        .select({ adminCount: count() })
        .from(usersTable)
        .where(and(eq(usersTable.firmId, user.firmId), eq(usersTable.role, "admin")));
      if (Number(adminCount) <= 1) {
        res.status(409).json({ error: "Cannot demote the last admin of a firm — promote another user to admin first." });
        return;
      }
    }

    await db
      .update(usersTable)
      .set({ role, updatedAt: new Date() })
      .where(eq(usersTable.id, id));

    logger.info({ userId: id, role }, "User role updated");
    res.json({ id, role });
  } catch (err) {
    logger.error({ err, userId: id }, "Failed to update user role");
    res.status(500).json({ error: "Failed to update user role" });
  }
});

/**
 * DELETE /api/users/:id
 * Admin-only: removes a user and drops their cached session.
 */
router.delete("/users/:id", bearerAuth, requireService, async (req: Request, res: Response) => {
  const id = String(req.params["id"]);
  try {
    const [user] = await db
      .select({ id: usersTable.id, role: usersTable.role, firmId: usersTable.firmId })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1);

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Guard: cannot delete the last admin of a firm
    if (user.role === "admin" && user.firmId) {
      const [{ adminCount }] = await db
        .select({ adminCount: count() })
        .from(usersTable)
        .where(and(eq(usersTable.firmId, user.firmId), eq(usersTable.role, "admin")));
      if (Number(adminCount) <= 1) {
        res.status(409).json({ error: "Cannot remove the last admin of a firm — promote another user to admin first." });
        return;
      }
    }

    invalidateUserSession(id);
    await db.delete(usersTable).where(eq(usersTable.id, id));
    logger.info({ userId: id }, "User deleted");
    res.json({ deleted: true, id });
  } catch (err) {
    logger.error({ err, userId: id }, "Failed to delete user");
    res.status(500).json({ error: "Failed to delete user" });
  }
});

/**
 * POST /api/users/:id/invite
 * Admin-only: generates a fresh one-time enrollment token for an existing user
 * and returns the enrollment URL. Use this when the original link has expired
 * or was consumed. If the user has an email address, also sends a new invite email.
 */
router.post("/users/:id/invite", bearerAuth, requireService, async (req: Request, res: Response) => {
  const id = String(req.params["id"]);
  try {
    const [user] = await db
      .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, firmId: usersTable.firmId })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1);

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const enrollToken = randomBytes(32).toString("hex");
    const enrollTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await db
      .update(usersTable)
      .set({ enrollToken, enrollTokenExpiresAt, updatedAt: new Date() })
      .where(eq(usersTable.id, id));

    const enrollUrl = `/api/auth/user/enroll?token=${enrollToken}`;
    logger.info({ userId: id }, "Enrollment token regenerated");

    if (user.email) {
      try {
        const { sendInviteEmail } = await import("../lib/emailService.js");
        let firmName = "your organization";
        if (user.firmId) {
          const [firm] = await db.select({ name: firmsTable.name }).from(firmsTable).where(eq(firmsTable.id, user.firmId)).limit(1);
          if (firm) firmName = firm.name;
        }
        const baseUrl = getBaseUrl();
        await sendInviteEmail({
          toEmail: user.email,
          userName: user.name,
          firmName,
          enrollUrl: `${baseUrl}${enrollUrl}`,
        });
      } catch (emailErr) {
        logger.warn({ emailErr, userId: id }, "Failed to send re-invite email (token still valid)");
      }
    }

    res.json({ id, enrollUrl });
  } catch (err) {
    logger.error({ err, userId: id }, "Failed to regenerate enrollment token");
    res.status(500).json({ error: "Failed to regenerate enrollment token" });
  }
});

function enrollForm(token: string, userName: string, firmName?: string | null, errorMsg?: string): string {
  const e = escapeHtml;
  const err = errorMsg
    ? `<p style="color:#f87171;margin:0 0 16px;font-size:14px">${e(errorMsg)}</p>`
    : "";
  const firmBadge = firmName
    ? `<div style="display:inline-flex;align-items:center;gap:6px;background:rgba(56,189,248,0.08);border:1px solid rgba(56,189,248,0.25);border-radius:20px;padding:4px 12px;margin-bottom:20px">
        <span style="width:6px;height:6px;border-radius:50%;background:#38bdf8;display:inline-block"></span>
        <span style="font-size:12px;color:#38bdf8;letter-spacing:0.05em">${e(firmName)}</span>
       </div>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Bullhorn | ${e(userName)}</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1020;color:#e8ecf3;
  display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
main{max-width:420px;width:100%;padding:40px 32px;background:#141927;border-radius:12px;border:1px solid #1e2a3a}
.logo{display:flex;align-items:center;gap:10px;margin-bottom:24px}
.logo-text{font-size:18px;font-weight:800;letter-spacing:-0.02em;color:#f8fafc}
.logo-text span{color:#38BDF8}
h1{font-size:20px;margin:0 0 6px}
.sub{font-size:14px;color:#7a8ba0;margin:0 0 24px}
label{display:block;font-size:13px;color:#aab4c5;margin-bottom:6px}
input{width:100%;padding:10px 14px;background:#0b1020;border:1px solid #1e2a3a;border-radius:8px;
  color:#e8ecf3;font-size:15px;margin-bottom:16px;outline:none}
input:focus{border-color:#3b82f6}
button{width:100%;padding:12px;background:#3b82f6;color:#fff;border:none;border-radius:8px;
  font-size:15px;font-weight:600;cursor:pointer}
button:hover{background:#2563eb}
.note{font-size:12px;color:#4a5568;margin-top:16px;text-align:center}
</style></head>
<body><main>
<div class="logo">
<svg width="28" height="28" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#4338CA"/><stop offset="55%" stop-color="#4F46E5"/><stop offset="100%" stop-color="#0EA5E9"/></linearGradient></defs><rect width="48" height="48" rx="13" fill="url(#g)"/><path d="M11 5 C11 3.3 12.3 2 14 2 L34 2 C35.7 2 37 3.3 37 5 L37 27 C37 28.7 35.7 30 34 30 L27.5 30 L24 36.5 L20.5 30 L14 30 C12.3 30 11 28.7 11 27 Z" fill="white" fill-opacity="0.97"/><line x1="15.5" y1="16" x2="29.5" y2="16" stroke="#4338CA" stroke-width="3" stroke-linecap="round"/><polyline points="25,11 31,16 25,21" fill="none" stroke="#4338CA" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
<span class="logo-text">Ask<span>To</span>Act</span>
</div>
${firmBadge}
<h1>Connect your Bullhorn account</h1>
<p class="sub">Linking as <strong>${e(userName)}</strong>. Your credentials go directly to Bullhorn and are not stored by this server.</p>
${err}
<form method="POST" action="/api/auth/user/enroll">
  <input type="hidden" name="token" value="${e(token)}">
  <label for="u">Bullhorn username</label>
  <input id="u" type="text" name="bhUsername" autocomplete="username" required placeholder="Your Bullhorn username">
  <label for="p">Bullhorn password</label>
  <input id="p" type="password" name="bhPassword" autocomplete="current-password" required>
  <button type="submit">Connect account</button>
</form>
<p class="note">This connects your personal Bullhorn login so the AI connector can write notes, update statuses, and submit candidates as you.</p>
</main></body></html>`;
}

/**
 * GET /api/auth/user/enroll?token=<enrollToken>
 * No auth required — shows the recruiter a credentials form. The token is
 * one-time-use and expires after 7 days; use POST /api/users/:id/invite to
 * generate a fresh link. Submitting the form does the full OAuth flow
 * server-side (headless) so the Bullhorn consent bounce is avoided entirely.
 */
router.get("/auth/user/enroll", async (req: Request, res: Response) => {
  const token = req.query["token"];
  if (typeof token !== "string" || token.length === 0) {
    res.status(400).send(page("Invalid enrollment link", "This enrollment link is missing or invalid. Ask your administrator for a new link."));
    return;
  }
  try {
    const rows = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        firmId: usersTable.firmId,
        enrollToken: usersTable.enrollToken,
        enrollTokenExpiresAt: usersTable.enrollTokenExpiresAt,
      })
      .from(usersTable)
      .where(eq(usersTable.enrollToken, token))
      .limit(1);

    if (!rows[0]) {
      res.status(404).send(page("Link not found", "This enrollment link is invalid or has already been used. Ask your administrator for a new link."));
      return;
    }

    if (!rows[0].enrollTokenExpiresAt || rows[0].enrollTokenExpiresAt < new Date()) {
      res.status(410).send(page("Link expired", "This enrollment link has expired. Ask your administrator to send you a new one."));
      return;
    }

    // Subscription gate: if this user belongs to a firm, verify the firm has an active subscription
    const { firmId } = rows[0];
    let firmName: string | null = null;
    if (firmId) {
      const [firm] = await db
        .select({ name: firmsTable.name })
        .from(firmsTable)
        .where(eq(firmsTable.id, firmId))
        .limit(1);
      firmName = firm?.name ?? null;

      const status = await stripeStorage.resolveFirmStatus(firmId);
      if (status !== "active" && status !== "trialing") {
        res.status(402).send(page(
          "Subscription required",
          "Your firm's AskToAct subscription is not active. Ask your administrator to complete payment before enrolling.",
        ));
        return;
      }
    }

    res.send(enrollForm(token, rows[0].name, firmName));
  } catch (err) {
    logger.error({ err }, "Enrollment form failed");
    res.status(500).send(page("Error", "Could not load the enrollment page. Please try again."));
  }
});

/**
 * POST /api/auth/user/enroll
 * Handles form submission: runs the full headless OAuth flow server-side so
 * the Bullhorn consent form is approved without browser redirects.
 * Requires a valid one-time enrollment token; the token is consumed on success.
 */
router.post("/auth/user/enroll", async (req: Request, res: Response) => {
  const { token, bhUsername, bhPassword } = req.body as {
    token?: string;
    bhUsername?: string;
    bhPassword?: string;
  };

  if (!token || !bhUsername || !bhPassword) {
    res.status(400).send(page("Missing fields", "Enrollment token, username, and password are all required."));
    return;
  }

  try {
    const rows = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        firmId: usersTable.firmId,
        enrollToken: usersTable.enrollToken,
        enrollTokenExpiresAt: usersTable.enrollTokenExpiresAt,
      })
      .from(usersTable)
      .where(eq(usersTable.enrollToken, token))
      .limit(1);

    if (!rows[0]) {
      res.status(404).send(page("Link not found", "This enrollment link is invalid or has already been used. Ask your administrator for a new link."));
      return;
    }

    if (!rows[0].enrollTokenExpiresAt || rows[0].enrollTokenExpiresAt < new Date()) {
      res.status(410).send(page("Link expired", "This enrollment link has expired. Ask your administrator to send you a new one."));
      return;
    }

    const id = rows[0].id;

    await enrollUserHeadless(id, bhUsername.trim(), bhPassword);
    logger.info({ userId: id }, "Bullhorn: per-user headless enrollment complete via form");

    await db
      .update(usersTable)
      .set({ enrollToken: null, enrollTokenExpiresAt: null, updatedAt: new Date() })
      .where(eq(usersTable.id, id));

    const [enrolledUser] = await db
      .select({ apiKey: usersTable.apiKey, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1);

    const baseUrl = getBaseUrl();
    const mcpUrl = enrolledUser ? `${baseUrl}/api/mcp/${enrolledUser.apiKey}` : null;
    const e = escapeHtml;

    const toolSteps: Record<string, { label: string; tagline: string; steps: string[] }> = {
      chatgpt: {
        label: "ChatGPT",
        tagline: "Recommended — full read &amp; write (notes, status updates, submittals) with your own Bullhorn identity.",
        steps: [
          "Go to <strong>chatgpt.com</strong>, click your profile icon (top-right), then <strong>Settings</strong>",
          "Select <strong>Connectors</strong> from the left menu, then click <strong>Add</strong>",
          "<strong>Name:</strong> We recommend <strong>AskToAct</strong> — but you can use any name you like. This name is how you activate the connector in chat (by typing a backslash followed by the name), so choose something easy to remember",
          "<strong>Description</strong> (optional, but recommended): copy and paste — <em>Bullhorn ATS connector — search candidates, manage jobs and placements, read résumés, and update records directly from chat</em> — or write your own",
          "Under <strong>Connection</strong>, confirm <strong>Server URL</strong> is selected, then paste your connector URL (above) into the URL field",
          "Set <strong>Authentication</strong> to <strong>No authentication</strong> — your personal key is already embedded in the URL",
          "Check <strong>I understand and want to continue</strong>, then click <strong>Create</strong>",
          "<strong>Important — enable write access:</strong> After the connector is created, click on it to view its tools. Any tool listed as <strong>Block</strong> will prevent write actions (adding notes, updating records, submitting candidates). Click each blocked tool and change it to <strong>Always allow</strong>",
          "Open a new chat. To activate the connector, type <strong>\\</strong> (backslash), start typing the name you chose (e.g. <strong>AskToAct</strong>), and select it from the list — your Bullhorn tools are now active for that conversation",
        ],
      },
      claude: {
        label: "Claude",
        tagline: "Full read &amp; write via Claude's custom connectors (Pro, Max, Team, or Enterprise).",
        steps: [
          "Go to <strong>claude.ai</strong> and sign in, then open <strong>Settings</strong> and select <strong>Connectors</strong>",
          "Click <strong>Add custom connector</strong>",
          "<strong>Name:</strong> We recommend <strong>AskToAct</strong> — but you can use any name. You will select this connector by name when starting a chat or attaching it to a Project",
          "<strong>Description</strong> (optional, but recommended): copy and paste — <em>Bullhorn ATS connector — search candidates, manage jobs and placements, read résumés, and update records directly from chat</em> — or write your own",
          "Paste your connector URL (above) as the <strong>Remote MCP server URL</strong>, then click <strong>Add</strong>",
          "In a new chat, click the connector/tools icon and enable <strong>AskToAct</strong> (or the name you chose) — or attach it to a Project so it is always available",
          "Start a conversation — your Bullhorn tools will be active",
        ],
      },
      gemini: {
        label: "Gemini",
        tagline: "MCP connector support — steps may vary by plan and Google Workspace version.",
        steps: [
          "Go to <strong>gemini.google.com</strong> and sign in with your Google account",
          "Click your profile icon (top-right) then <strong>Settings</strong>, and look for <strong>Extensions</strong>, <strong>Integrations</strong>, or <strong>Connectors</strong>",
          "Select <strong>Add custom connector</strong> or <strong>Add MCP server</strong>",
          "<strong>Name:</strong> We recommend <strong>AskToAct</strong> — but you can use any name. <strong>Description</strong> (if prompted): <em>Bullhorn ATS connector — search candidates, manage jobs and placements, read résumés, and update records directly from chat</em>",
          "Paste your connector URL (above) and authorize the connection",
          "If you see any permission or access settings, ensure write actions are set to <strong>Allow</strong> (not Block) so the connector can update records in your ATS",
          "Start a conversation — your Bullhorn tools will be available. Refer to your Gemini plan's documentation if the connector option does not appear",
        ],
      },
      grok: {
        label: "Grok",
        tagline: "Full read &amp; write via Grok's custom connectors.",
        steps: [
          "Go to <strong>grok.com</strong> (or open Grok within X) and sign in",
          "Click <strong>Settings</strong> then look for <strong>Connectors</strong> or <strong>Integrations</strong>",
          "Select <strong>Add custom connector</strong>",
          "<strong>Name:</strong> We recommend <strong>AskToAct</strong> — but you can use any name. <strong>Description</strong> (if prompted): <em>Bullhorn ATS connector — search candidates, manage jobs and placements, read résumés, and update records directly from chat</em>",
          "Paste your connector URL (above) and authorize the connection",
          "If you see any permission settings, ensure write actions are set to <strong>Allow</strong> so the connector can update your ATS records",
          "Start a new chat and activate the connector — your Bullhorn tools will be available",
        ],
      },
      other: {
        label: "Other tool",
        tagline: "Any tool that supports a remote MCP server.",
        steps: [
          "Open your AI tool and sign in",
          "Find <strong>Settings</strong> then look for <strong>Connectors</strong>, <strong>Integrations</strong>, or <strong>MCP servers</strong>",
          "Add a new custom connector. <strong>Name:</strong> We recommend <strong>AskToAct</strong> — but you can use any name. <strong>Description</strong> (if prompted): <em>Bullhorn ATS connector — search candidates, manage jobs and placements, read résumés, and update records directly from chat</em>",
          "Paste your connector URL (above) and authorize or save the connection",
          "If you see any permission or access settings, ensure write actions are set to <strong>Allow</strong> (not Block) so the connector can update records in your ATS",
          "Start a conversation and confirm your Bullhorn tools appear",
        ],
      },
    };

    const toolOrder = ["chatgpt", "claude", "gemini", "grok", "other"] as const;

    const toolTabsHtml = toolOrder.map((key) => `
      <button class="tool-tab" data-tool="${key}" onclick="selectTool('${key}')">${toolSteps[key].label}</button>
    `).join("");

    const toolPanelsHtml = toolOrder.map((key) => {
      const stepsHtml = toolSteps[key].steps.map((s, i) => `
        <div class="step">
          <span class="step-num">${i + 1}</span>
          <p class="step-text">${s}</p>
        </div>`).join("");
      const tagline = toolSteps[key].tagline ? `<p class="tool-tagline">${toolSteps[key].tagline}</p>` : "";
      return `<div class="tool-panel" id="panel-${key}" style="display:none">${tagline}${stepsHtml}</div>`;
    }).join("");

    res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connected | AskToAct</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1020;color:#e8ecf3;
  display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:20px}
main{max-width:500px;width:100%}
.logo{display:flex;align-items:center;gap:8px;margin-bottom:28px}
.logo-badge{width:28px;height:28px;border-radius:8px;background:#4F46E5;display:flex;align-items:center;justify-content:center}
.logo-dot{width:10px;height:10px;border-radius:50%;background:#fff}
.logo-name{font-weight:700;font-size:15px}
.card{background:#141927;border:1px solid #1e2a3a;border-radius:16px;padding:32px}
.check{width:44px;height:44px;border-radius:50%;background:rgba(16,185,129,.15);border:1px solid rgba(52,211,153,.3);
  display:flex;align-items:center;justify-content:center;font-size:20px;margin-bottom:16px}
h1{font-size:20px;font-weight:800;margin:0 0 8px;letter-spacing:-0.02em}
.sub{font-size:14px;color:#7a8ba0;margin:0 0 24px;line-height:1.6}
.mcp-label{font-size:11px;font-weight:600;letter-spacing:.1em;color:#38bdf8;text-transform:uppercase;margin-bottom:8px}
.mcp-box{background:#0b1020;border:1px solid #1e2a3a;border-radius:10px;padding:14px 16px;
  font-family:monospace;font-size:12px;color:#cbd5e1;word-break:break-all;line-height:1.6;margin-bottom:8px;cursor:pointer}
.mcp-box:hover{border-color:#38bdf8}
.copy-btn{width:100%;padding:10px;background:#4F46E5;color:#fff;border:none;border-radius:8px;
  font-size:13px;font-weight:600;cursor:pointer;margin-bottom:24px}
.copy-btn:hover{background:#4338ca}
.tool-section{border-top:1px solid #1e2a3a;padding-top:20px}
.tool-label{font-size:11px;font-weight:600;letter-spacing:.1em;color:#64748b;text-transform:uppercase;margin-bottom:12px}
.tool-tabs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px}
.tool-tab{padding:6px 14px;border-radius:20px;border:1px solid #1e2a3a;background:#0f1622;
  color:#64748b;font-size:13px;font-weight:500;cursor:pointer;transition:all .15s}
.tool-tab:hover{border-color:#38bdf8;color:#94a3b8}
.tool-tab.active{border-color:#4F46E5;background:rgba(79,70,229,.15);color:#818cf8;font-weight:600}
.tool-tagline{font-size:12px;color:#94a3b8;line-height:1.5;margin:0 0 16px;padding:10px 12px;
  background:rgba(79,70,229,.08);border:1px solid rgba(79,70,229,.2);border-radius:8px}
.step{display:flex;gap:12px;margin-bottom:14px;align-items:flex-start}
.step-num{width:22px;height:22px;border-radius:50%;background:rgba(79,70,229,.2);border:1px solid rgba(79,70,229,.4);
  color:#818cf8;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
.step-text{font-size:13px;color:#6b7a99;line-height:1.6;margin:0}
.step-text strong{color:#cbd5e1}
.note{margin-top:16px;font-size:11px;color:#2d3748;line-height:1.5}
</style></head>
<body><main>
<div class="logo">
  <div class="logo-badge"><span class="logo-dot"></span></div>
  <span class="logo-name">AskToAct</span>
</div>
<div class="card">
  <div class="check">✓</div>
  <h1>Bullhorn account connected!</h1>
  <p class="sub">Linked as <strong style="color:#e8ecf3">${e(bhUsername.trim())}</strong>. Your AI connector is ready.</p>
  ${mcpUrl ? `
  <p class="mcp-label">Your personal connector URL</p>
  <div class="mcp-box" id="mcp" title="Click to select all">${e(mcpUrl)}</div>
  <button class="copy-btn" id="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('mcp').textContent.trim()).then(()=>{this.textContent='Copied!';setTimeout(()=>{this.textContent='Copy connector URL'},2000)})">Copy connector URL</button>
  ` : ""}
  <div class="tool-section">
    <p class="tool-label">Which AI tool are you using?</p>
    <div class="tool-tabs">${toolTabsHtml}</div>
    ${toolPanelsHtml}
    <p class="note">Navigation may vary slightly depending on your plan or version. If you cannot find Connectors, search your tool's help center for "MCP" or "custom connector."</p>
  </div>
</div>
</main>
<script>
function selectTool(key) {
  document.querySelectorAll('.tool-tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.tool === key);
  });
  document.querySelectorAll('.tool-panel').forEach(function(p) {
    p.style.display = p.id === 'panel-' + key ? 'block' : 'none';
  });
}
// Pre-select MCP URL on click
const box = document.getElementById('mcp');
if (box) box.addEventListener('click', function() {
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(box);
  sel.removeAllRanges();
  sel.addRange(range);
});
// Default to ChatGPT
selectTool('chatgpt');
</script>
</body></html>`);
  } catch (err) {
    const msg = (err as Error).message ?? "Unknown error";
    logger.error({ err }, "Per-user headless enrollment failed");
    const userRows = await db
      .select({ name: usersTable.name, firmId: usersTable.firmId })
      .from(usersTable)
      .where(eq(usersTable.enrollToken, token))
      .limit(1)
      .catch(() => []);
    const name = userRows[0]?.name ?? "Unknown";
    const fId = userRows[0]?.firmId ?? null;
    let firmName: string | null = null;
    if (fId) {
      const [firm] = await db.select({ name: firmsTable.name }).from(firmsTable).where(eq(firmsTable.id, fId)).limit(1).catch(() => []);
      firmName = firm?.name ?? null;
    }
    res.status(400).send(enrollForm(token, name, firmName, msg));
  }
});

export default router;
