import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { db, usersTable, firmsTable } from "@workspace/db";
import { and, count, eq } from "drizzle-orm";
import { bearerAuth, requireService } from "../middlewares/bearer-auth.js";
import {
  invalidateUserSession,
  enrollUserHeadless,
  getAuthorizeUrl,
} from "../lib/bullhorn-auth.js";
import { rememberState } from "../lib/oauth-state.js";
import { stripeStorage } from "../lib/stripe/storage.js";
import { logger } from "../lib/logger.js";
import { getBaseUrl } from "../lib/getBaseUrl.js";
import { escapeHtml, page } from "../lib/html.js";
import { nonceAttr } from "../lib/csp-nonce.js";

const router: IRouter = Router();

/**
 * POST /api/users
 * Admin-only: creates a recruiter user and returns their API key (shown once).
 * Body: { name: string, email: string }
 * Email is required and must be unique — the Clerk identity bridge matches portal
 * logins by email, so a user without one can never sign in.
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

  if (!email || typeof email !== "string" || email.trim().length === 0) {
    res.status(400).json({ error: "email is required" });
    return;
  }
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    res.status(400).json({ error: "email must be a valid email address" });
    return;
  }
  const [existingEmail] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail))
    .limit(1);
  if (existingEmail) {
    res.status(409).json({ error: `A user with email '${normalizedEmail}' already exists` });
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
      email: normalizedEmail,
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
      email: normalizedEmail,
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
    // Race-safe duplicate handling: two concurrent creates can both pass the
    // pre-check above, so the DB unique constraint is the final arbiter.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: string }).code === "23505"
    ) {
      res.status(409).json({ error: `A user with email '${normalizedEmail}' already exists` });
      return;
    }
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

/**
 * POST /api/users/:id/reset
 * Admin-only: resets a user to a brand-new, un-onboarded state so the full
 * onboarding flow can be re-tested as if they were signing up for the first
 * time. Clears the Bullhorn connection (refresh/REST tokens + session), drops
 * the cached in-memory session, ROTATES the API key (so the connector URL is
 * freshly issued like a new signup), and generates a new one-time enrollment
 * link. Identity is preserved (name, email, firm, role). Returns the new apiKey
 * (shown once) and enrollUrl. Does NOT auto-send email — the admin controls
 * delivery; use POST /api/users/:id/invite to email the link instead.
 */
router.post("/users/:id/reset", bearerAuth, requireService, async (req: Request, res: Response) => {
  const id = String(req.params["id"]);
  try {
    const [user] = await db
      .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1);

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const apiKey = randomBytes(32).toString("hex");
    const enrollToken = randomBytes(32).toString("hex");
    const enrollTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    invalidateUserSession(id);

    await db
      .update(usersTable)
      .set({
        apiKey,
        refreshToken: null,
        bhRestToken: null,
        restUrl: null,
        tokenExpiresAt: null,
        sessionExpiresAt: null,
        enrollToken,
        enrollTokenExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, id));

    logger.info({ userId: id }, "User reset to first-time onboarding state");

    res.json({
      id,
      name: user.name,
      email: user.email,
      apiKey,
      enrollUrl: `${getBaseUrl()}/api/auth/user/enroll?token=${enrollToken}`,
      message:
        "User reset to a first-time state. Their Bullhorn connection and previous API key " +
        "are revoked. Open enrollUrl in a browser to walk through onboarding exactly as the " +
        "user would. The enrollment link expires in 7 days.",
    });
  } catch (err) {
    logger.error({ err, userId: id }, "Failed to reset user");
    res.status(500).json({ error: "Failed to reset user" });
  }
});

/**
 * Shared connector-setup page rendered both after a fresh Bullhorn connection
 * (alreadyConnected=false) and when a returning connected user re-opens their
 * access link (alreadyConnected=true).
 */
export function connectorSetupPage(displayName: string, mcpUrl: string | null, alreadyConnected: boolean): string {
  const e = escapeHtml;
  const toolSteps: Record<string, { label: string; tagline: string; steps: string[] }> = {
    chatgpt: {
      label: "ChatGPT",
      tagline: "Recommended — full read &amp; write (notes, status updates, submittals) with your own Bullhorn identity.",
      steps: [
        "Go to <strong>chatgpt.com</strong>, click your profile icon (top-right), then <strong>Settings</strong>",
        "Select <strong>Beta features</strong> from the left menu and turn on <strong>Developer mode</strong> — this unlocks the Apps section you need in the next steps. (If you already see <strong>Apps</strong> in the left menu, you can skip this step.)",
        "Still in Settings, select <strong>Apps</strong> from the left menu",
        "Scroll to the bottom of the page and click <strong>Create app</strong>",
        "<strong>Name:</strong> We recommend <strong>AskToAct</strong> — but you can use any name you like. You will activate the connector in chat by typing <strong>@</strong> followed by the name, so choose something easy to remember",
        "<strong>Description</strong> (optional, but recommended): copy and paste — <em>Bullhorn ATS connector — search candidates, manage jobs and placements, read résumés, and update records directly from chat</em> — or write your own",
        "Under <strong>Connection</strong>, confirm <strong>Server URL</strong> is selected, then paste your connector URL (above) into the URL field",
        "Set <strong>Authentication</strong> to <strong>No authentication</strong> — your personal key is already embedded in the URL",
        "Check <strong>I understand and want to continue</strong>, then click <strong>Create</strong>",
        "<strong>Enable write access:</strong> Back on the Apps page, click on <strong>AskToAct</strong> (or your chosen name). Under <strong>Permissions</strong>, open the dropdown and select <strong>Allow all actions</strong> — this lets AskToAct update Bullhorn records without a confirmation prompt each time. You may see a <strong>DEV</strong> badge next to the app name — this is normal for custom connectors and does not affect functionality",
        "Open a new chat. Type <strong>@</strong> and start typing the name you chose (e.g. <strong>@AskToAct</strong>) — select it from the <strong>Plugins</strong> dropdown that appears, and your Bullhorn tools are now active for that conversation",
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
      <button class="tool-tab" data-tool="${key}">${toolSteps[key].label}</button>
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

  const subtitle = alreadyConnected
    ? `Welcome back, <strong style="color:#e8ecf3">${e(displayName)}</strong>. You're already connected to Bullhorn — here's your connector setup to complete or reference:`
    : `Linked as <strong style="color:#e8ecf3">${e(displayName)}</strong>. Your AI connector is ready.`;

  const helpNameJson = JSON.stringify(displayName).replace(/</g, "\\u003c");

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connected | AskToAct</title>
<style${nonceAttr()}>
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1020;color:#e8ecf3;
  display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:20px}
main{max-width:500px;width:100%}
.logo{display:flex;align-items:center;gap:8px;margin-bottom:28px}
.logo-text{font-size:18px;font-weight:800;letter-spacing:-0.02em;color:#f8fafc}
.logo-text span{color:#38BDF8}
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
.help-row{border-top:1px solid #1e2a3a;margin-top:22px;padding-top:18px;text-align:center}
.help-link{display:inline-block;font-size:13px;font-weight:600;color:#818cf8;text-decoration:none;
  padding:9px 16px;border:1px solid rgba(79,70,229,.35);border-radius:8px;transition:all .15s}
.help-link:hover{border-color:#4F46E5;background:rgba(79,70,229,.12);color:#a5b4fc}
.help-sub{font-size:12px;color:#64748b;margin:10px 0 0}
.help-toggle{display:inline-block;font-size:13px;font-weight:600;color:#818cf8;background:none;cursor:pointer;
  padding:9px 16px;border:1px solid rgba(79,70,229,.35);border-radius:8px;transition:all .15s}
.help-toggle:hover{border-color:#4F46E5;background:rgba(79,70,229,.12);color:#a5b4fc}
.help-form{margin-top:16px;text-align:left;display:none}
.help-form.open{display:block}
.help-field{margin-bottom:12px}
.help-field label{display:block;font-size:12px;color:#94a3b8;margin-bottom:5px;font-weight:500}
.help-input,.help-textarea{width:100%;background:#0b1020;border:1px solid #1e2a3a;border-radius:8px;
  padding:10px 12px;color:#e8ecf3;font-size:13px;font-family:inherit}
.help-input:focus,.help-textarea:focus{outline:none;border-color:#4F46E5}
.help-textarea{resize:vertical;min-height:90px;line-height:1.5}
.help-hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
.help-send{width:100%;padding:11px;background:#4F46E5;color:#fff;border:none;border-radius:8px;
  font-size:13px;font-weight:600;cursor:pointer}
.help-send:hover{background:#4338ca}
.help-send:disabled{opacity:.6;cursor:default}
.help-status{font-size:12px;margin-top:10px;line-height:1.5}
.help-status.ok{color:#34d399}
.help-status.err{color:#f87171}
</style></head>
<body><main>
<div class="logo">
<svg width="28" height="28" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#4338CA"/><stop offset="55%" stop-color="#4F46E5"/><stop offset="100%" stop-color="#0EA5E9"/></linearGradient></defs><rect width="48" height="48" rx="13" fill="url(#g)"/><path d="M11 5 C11 3.3 12.3 2 14 2 L34 2 C35.7 2 37 3.3 37 5 L37 27 C37 28.7 35.7 30 34 30 L27.5 30 L24 36.5 L20.5 30 L14 30 C12.3 30 11 28.7 11 27 Z" fill="white" fill-opacity="0.97"/><line x1="15.5" y1="16" x2="29.5" y2="16" stroke="#4338CA" stroke-width="3" stroke-linecap="round"/><polyline points="25,11 31,16 25,21" fill="none" stroke="#4338CA" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
<span class="logo-text">Ask<span>To</span>Act</span>
</div>
<div class="card">
  <div class="check">✓</div>
  <h1>Bullhorn account connected!</h1>
  <p class="sub">${subtitle}</p>
  ${mcpUrl ? `
  <p class="mcp-label">Your personal connector URL</p>
  <div class="mcp-box" id="mcp" title="Click to select all">${e(mcpUrl)}</div>
  <button class="copy-btn" id="copy-btn">Copy connector URL</button>
  ` : ""}
  <div class="tool-section">
    <p class="tool-label">Which AI tool are you using?</p>
    <div class="tool-tabs">${toolTabsHtml}</div>
    ${toolPanelsHtml}
    <p class="note">Navigation may vary slightly depending on your plan or version. If you cannot find Connectors, search your tool's help center for "MCP" or "custom connector."</p>
  </div>
  <div class="help-row">
    <button type="button" class="help-toggle" id="help-toggle">✉️ Ask for help with setup</button>
    <p class="help-sub" id="help-sub">Stuck on any step? Send our support team a message and we'll reply by email.</p>
    <form class="help-form" id="help-form">
      <input type="text" class="help-hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <div class="help-field">
        <label for="help-email">Your email (so we can reply)</label>
        <input type="email" class="help-input" id="help-email" required placeholder="you@company.com">
      </div>
      <div class="help-field">
        <label for="help-message">What do you need help with?</label>
        <textarea class="help-textarea" id="help-message" required placeholder="Describe where you're stuck…"></textarea>
      </div>
      <button type="submit" class="help-send" id="help-send">Send message</button>
      <p class="help-status" id="help-status"></p>
    </form>
  </div>
</div>
</main>
<script${nonceAttr()}>
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
// Inline help form
var HELP_NAME = ${helpNameJson};
function toggleHelp() {
  var f = document.getElementById('help-form');
  var sub = document.getElementById('help-sub');
  var open = f.classList.toggle('open');
  document.getElementById('help-toggle').textContent = open ? '✕ Close' : '✉️ Ask for help with setup';
  if (sub) sub.style.display = open ? 'none' : 'block';
  if (open) document.getElementById('help-email').focus();
}
function submitHelp(ev) {
  ev.preventDefault();
  var btn = document.getElementById('help-send');
  var status = document.getElementById('help-status');
  status.textContent = ''; status.className = 'help-status';
  btn.disabled = true; btn.textContent = 'Sending…';
  fetch('/api/support/help', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: HELP_NAME,
      email: document.getElementById('help-email').value,
      message: document.getElementById('help-message').value,
      website: document.querySelector('#help-form [name=website]').value
    })
  }).then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
    .then(function(res){
      if (res.ok) {
        document.getElementById('help-form').innerHTML =
          '<p class="help-status ok">' + ((res.d && res.d.message) || 'Your message has been sent — our team will reach out shortly.') + '</p>';
      } else {
        status.textContent = (res.d && res.d.error) || 'Something went wrong. Please try again.';
        status.className = 'help-status err';
        btn.disabled = false; btn.textContent = 'Send message';
      }
    }).catch(function(){
      status.textContent = 'Network error. Please try again.';
      status.className = 'help-status err';
      btn.disabled = false; btn.textContent = 'Send message';
    });
  return false;
}
// Wire DOM event handlers here — no inline on* attributes (CSP script-src-attr 'none').
document.querySelectorAll('.tool-tab').forEach(function(t){
  t.addEventListener('click', function(){ selectTool(t.dataset.tool); });
});
var copyBtn = document.getElementById('copy-btn');
if (copyBtn) copyBtn.addEventListener('click', function(){
  var self = this;
  navigator.clipboard.writeText(document.getElementById('mcp').textContent.trim()).then(function(){
    self.textContent = 'Copied!';
    setTimeout(function(){ self.textContent = 'Copy connector URL'; }, 2000);
  });
});
var helpToggle = document.getElementById('help-toggle');
if (helpToggle) helpToggle.addEventListener('click', toggleHelp);
var helpForm = document.getElementById('help-form');
if (helpForm) helpForm.addEventListener('submit', submitHelp);
</script>
</body></html>`;
}

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
<style${nonceAttr()}>
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
.help-link{display:block;text-align:center;margin-top:16px;font-size:13px;color:#6B7A99;text-decoration:none}
.help-link:hover{color:#94a3b8}
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
<a class="help-link" href="mailto:support@asktoact.ai?subject=${encodeURIComponent("Help connecting my Bullhorn account")}&body=${encodeURIComponent("Hi AskToAct support,\n\nI'm trying to connect my Bullhorn account but I'm running into an issue.\n\nMy name: " + userName + (firmName ? "\nFirm: " + firmName : "") + "\n\nCould you help me get connected?\n\nThanks")}">Need help? Contact support</a>
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
        refreshToken: usersTable.refreshToken,
        apiKey: usersTable.apiKey,
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

    // Already connected to Bullhorn — skip the credentials form and show the
    // connector-setup page (next phase) directly so the user can copy their
    // connector URL and follow the AI-tool instructions.
    if (rows[0].refreshToken) {
      const baseUrl = getBaseUrl();
      const mcpUrl = rows[0].apiKey ? `${baseUrl}/api/mcp/${rows[0].apiKey}` : null;
      res.send(connectorSetupPage(rows[0].name, mcpUrl, true));
      return;
    }

    // Escape hatch: ?manual=1 renders the legacy server-side credential form.
    // This is intentionally NOT linked from any page so search-engine crawlers
    // never see a Bullhorn password field on this domain (the pattern that got
    // the domain flagged as a "deceptive site"). Only used if Bullhorn's
    // first-time browser consent screen bounces for a given user.
    if (req.query["manual"] === "1") {
      res.send(enrollForm(token, rows[0].name, firmName));
      return;
    }

    // Default flow: redirect the recruiter to Bullhorn's own login page. The
    // user authenticates and approves consent on bullhorn.com — no password is
    // ever entered on this domain. Bullhorn redirects back to the shared
    // /api/auth/bullhorn/callback with an authorization code; the embedded
    // userId in the state routes it to completeUserEnrollment.
    const state = `user:${rows[0].id}:${randomBytes(16).toString("hex")}`;
    rememberState(state);
    const authorizeUrl = await getAuthorizeUrl(state);
    res.set("Cache-Control", "no-store");
    res.redirect(authorizeUrl);
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

    res.send(connectorSetupPage(bhUsername.trim(), mcpUrl, false));
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
