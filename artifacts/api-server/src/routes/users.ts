import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { db, usersTable, firmsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { bearerAuth } from "../middlewares/bearer-auth.js";
import {
  invalidateUserSession,
  enrollUserHeadless,
} from "../lib/bullhorn-auth.js";
import { stripeStorage } from "../lib/stripe/storage.js";
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
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t}</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1020;color:#e8ecf3;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}main{max-width:520px;padding:40px;text-align:center}h1{font-size:22px;margin:0 0 12px}p{font-size:15px;line-height:1.6;color:#aab4c5;margin:0}</style></head><body><main><h1>${t}</h1><p>${m}</p></main></body></html>`;
}

/**
 * POST /api/users
 * Admin-only: creates a recruiter user and returns their API key (shown once).
 * Body: { name: string, email?: string }
 * After creation, the user enrolls their Bullhorn account at the returned enrollUrl.
 */
router.post("/users", bearerAuth, async (req: Request, res: Response) => {
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
  const assignedRole = role === "admin" ? "admin" : "recruiter";

  try {
    await db.insert(usersTable).values({
      id,
      name: name.trim(),
      email: email?.trim() ?? null,
      apiKey,
      firmId: firmId ?? null,
      role: assignedRole,
    });
    logger.info({ userId: id, name: name.trim(), firmId, role: assignedRole }, "User created");
    res.status(201).json({
      id,
      name: name.trim(),
      email: email?.trim() ?? null,
      apiKey,
      firmId: firmId ?? null,
      role: assignedRole,
      enrollUrl: `/api/auth/user/enroll?id=${id}`,
      message:
        "Store this apiKey securely — it will not be shown again. " +
        "The user must visit enrollUrl in a browser to connect their Bullhorn account before write tools will work.",
    });
  } catch (err) {
    logger.error({ err }, "Failed to create user");
    res.status(500).json({ error: "Failed to create user" });
  }
});

/**
 * GET /api/users
 * Admin-only: lists all users (no apiKey or tokens exposed).
 */
router.get("/users", bearerAuth, async (_req: Request, res: Response) => {
  try {
    const rows = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        enrolled: usersTable.refreshToken,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable);
    res.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        enrolled: r.enrolled !== null,
        enrollUrl: `/api/auth/user/enroll?id=${r.id}`,
        createdAt: r.createdAt,
      })),
    );
  } catch (err) {
    logger.error({ err }, "Failed to list users");
    res.status(500).json({ error: "Failed to list users" });
  }
});

/**
 * DELETE /api/users/:id
 * Admin-only: removes a user and drops their cached session.
 */
router.delete("/users/:id", bearerAuth, async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    invalidateUserSession(id);
    await db.delete(usersTable).where(eq(usersTable.id, id));
    res.json({ deleted: true, id });
  } catch (err) {
    logger.error({ err, userId: id }, "Failed to delete user");
    res.status(500).json({ error: "Failed to delete user" });
  }
});

function enrollForm(userId: string, userName: string, errorMsg?: string): string {
  const e = escapeHtml;
  const err = errorMsg
    ? `<p style="color:#f87171;margin:0 0 16px;font-size:14px">${e(errorMsg)}</p>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Bullhorn — ${e(userName)}</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1020;color:#e8ecf3;
  display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
main{max-width:420px;width:100%;padding:40px 32px;background:#141927;border-radius:12px;border:1px solid #1e2a3a}
h1{font-size:20px;margin:0 0 6px}
.sub{font-size:14px;color:#7a8ba0;margin:0 0 28px}
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
<h1>Connect your Bullhorn account</h1>
<p class="sub">Linking as <strong>${e(userName)}</strong>. Your credentials go directly to Bullhorn — they are not stored by this server.</p>
${err}
<form method="POST" action="/api/auth/user/enroll">
  <input type="hidden" name="id" value="${e(userId)}">
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
 * GET /api/auth/user/enroll?id=<userId>
 * No auth required — shows the recruiter a credentials form. Submitting the
 * form does the full OAuth flow server-side (headless) so the Bullhorn consent
 * bounce is avoided entirely.
 */
router.get("/auth/user/enroll", async (req: Request, res: Response) => {
  const userId = req.query["id"];
  if (typeof userId !== "string" || userId.length === 0) {
    res.status(400).send(page("Missing user ID", "The enrollment link is missing the user ID. Ask your administrator for a valid enrollment link."));
    return;
  }
  try {
    const rows = await db
      .select({ id: usersTable.id, name: usersTable.name, firmId: usersTable.firmId })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (!rows[0]) {
      res.status(404).send(page("User not found", "This enrollment link is invalid. Ask your administrator to create your account."));
      return;
    }

    // Subscription gate: if this user belongs to a firm, verify the firm has an active subscription
    const { firmId } = rows[0];
    if (firmId) {
      const status = await stripeStorage.resolveFirmStatus(firmId);
      if (status !== "active" && status !== "trialing") {
        res.status(402).send(page(
          "Subscription required",
          "Your firm's AskToAct subscription is not active. Ask your administrator to complete payment before enrolling.",
        ));
        return;
      }
    }

    res.send(enrollForm(userId, rows[0].name));
  } catch (err) {
    logger.error({ err, userId }, "Enrollment form failed");
    res.status(500).send(page("Error", "Could not load the enrollment page. Please try again."));
  }
});

/**
 * POST /api/auth/user/enroll
 * Handles form submission: runs the full headless OAuth flow server-side so
 * the Bullhorn consent form is approved without browser redirects.
 */
router.post("/auth/user/enroll", async (req: Request, res: Response) => {
  const { id, bhUsername, bhPassword } = req.body as {
    id?: string;
    bhUsername?: string;
    bhPassword?: string;
  };

  if (!id || !bhUsername || !bhPassword) {
    res.status(400).send(page("Missing fields", "User ID, username, and password are all required."));
    return;
  }

  try {
    const rows = await db
      .select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1);
    if (!rows[0]) {
      res.status(404).send(page("User not found", "This enrollment link is invalid."));
      return;
    }

    await enrollUserHeadless(id, bhUsername.trim(), bhPassword);
    logger.info({ userId: id }, "Bullhorn: per-user headless enrollment complete via form");
    res.send(page(
      "Bullhorn account connected",
      `Your Bullhorn account (${escapeHtml(bhUsername.trim())}) is now linked. You can close this window — the AI connector will use your account for all write operations.`,
    ));
  } catch (err) {
    const msg = (err as Error).message ?? "Unknown error";
    logger.error({ err, userId: id }, "Per-user headless enrollment failed");
    const rows = await db
      .select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1)
      .catch(() => []);
    const name = rows[0]?.name ?? "Unknown";
    res.status(400).send(enrollForm(id, name, msg));
  }
});

export default router;
