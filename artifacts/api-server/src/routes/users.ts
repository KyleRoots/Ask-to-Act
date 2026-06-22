import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { bearerAuth } from "../middlewares/bearer-auth.js";
import {
  getUserEnrollUrl,
  invalidateUserSession,
} from "../lib/bullhorn-auth.js";
import { rememberState } from "../lib/oauth-state.js";
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
  const { name, email } = req.body as { name?: string; email?: string };
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const id = randomBytes(12).toString("hex");
  const apiKey = randomBytes(32).toString("hex");

  try {
    await db.insert(usersTable).values({
      id,
      name: name.trim(),
      email: email?.trim() ?? null,
      apiKey,
    });
    logger.info({ userId: id, name: name.trim() }, "User created");
    res.status(201).json({
      id,
      name: name.trim(),
      email: email?.trim() ?? null,
      apiKey,
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

/**
 * GET /api/auth/user/enroll?id=<userId>
 * No auth required — the recruiter opens this in their browser. Redirects them
 * to Bullhorn so they can log in with their own credentials. The callback lands
 * at the shared /api/auth/bullhorn/callback which routes user: states to the
 * per-user enrollment completion.
 */
router.get("/auth/user/enroll", async (req: Request, res: Response) => {
  const userId = req.query["id"];
  if (typeof userId !== "string" || userId.length === 0) {
    res
      .status(400)
      .send(
        page(
          "Missing user ID",
          "The enrollment link is missing the user ID. Ask your administrator for a valid enrollment link.",
        ),
      );
    return;
  }

  try {
    const rows = await db
      .select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (!rows[0]) {
      res
        .status(404)
        .send(
          page(
            "User not found",
            "This enrollment link is invalid. Ask your administrator to create your account.",
          ),
        );
      return;
    }

    const random = randomBytes(16).toString("hex");
    const state = `user:${userId}:${random}`;
    rememberState(state);

    const url = await getUserEnrollUrl(userId, state);
    res.redirect(url);
  } catch (err) {
    logger.error({ err, userId }, "User enrollment redirect failed");
    res
      .status(500)
      .send(page("Enrollment failed", "Could not start the Bullhorn login. Please try again."));
  }
});

export default router;
