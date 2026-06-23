import { type Request, type Response, type NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { db, usersTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";

/**
 * The AskToAct user identity resolved from a Clerk session, attached to the
 * request by requireClerkUser. Used by portal endpoints to scope data to the
 * caller's own firm and gate admin-only views.
 */
export interface PortalUser {
  id: string;
  name: string;
  email: string;
  role: string;
  firmId: string | null;
}

declare global {
  namespace Express {
    interface Request {
      portalUser?: PortalUser;
    }
  }
}

/**
 * Bridges a Clerk session to the local AskToAct user record. Requires a valid
 * Clerk session (set up by clerkMiddleware in app.ts), then resolves the
 * Clerk user's primary email and matches it (case-insensitively) to a row in
 * the users table. Attaches req.portalUser on success.
 *
 * Portal users are matched by email because they are provisioned by an admin
 * (with their email) before they ever sign in through Clerk — there is no
 * stored Clerk user id to key on.
 */
export async function requireClerkUser(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const auth = getAuth(req);
  const clerkUserId = auth?.userId;
  if (!clerkUserId) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }

  try {
    const clerkUser = await clerkClient.users.getUser(clerkUserId);
    const primary =
      clerkUser.emailAddresses.find(
        (e) => e.id === clerkUser.primaryEmailAddressId,
      ) ?? clerkUser.emailAddresses[0];
    const email = primary?.emailAddress?.trim().toLowerCase();

    if (!email) {
      res.status(403).json({ error: "No email on Clerk account" });
      return;
    }

    const rows = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        role: usersTable.role,
        firmId: usersTable.firmId,
      })
      .from(usersTable)
      .where(sql`lower(${usersTable.email}) = ${email}`)
      .limit(2);

    if (rows.length === 0) {
      res.status(403).json({
        error:
          "Your account is not provisioned in AskToAct. Contact your administrator.",
      });
      return;
    }

    // Fail closed on ambiguity: email is not unique in the schema, so if more
    // than one user shares this email (e.g. across firms) we cannot safely
    // decide which firm's data the caller may see. Refuse rather than risk
    // binding to the wrong tenant.
    if (rows.length > 1) {
      logger.error(
        { email, clerkUserId },
        "requireClerkUser: ambiguous email maps to multiple users — refusing to bind",
      );
      res.status(409).json({
        error:
          "Your email is linked to more than one account. Contact your administrator.",
      });
      return;
    }

    const user = rows[0];

    req.portalUser = {
      id: user.id,
      name: user.name,
      email: user.email ?? email,
      role: user.role,
      firmId: user.firmId,
    };
    next();
  } catch (err) {
    logger.warn({ err, clerkUserId }, "requireClerkUser: bridge failed");
    res.status(401).json({ error: "Could not resolve account" });
  }
}

/**
 * Gate that restricts a route to firm admins. Must run AFTER requireClerkUser.
 * A non-admin portal user is rejected with 403 so a recruiter can never view
 * their teammates' activity.
 */
export function requireFirmAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (req.portalUser?.role !== "admin") {
    res.status(403).json({
      error: "Forbidden: this view is available to firm administrators only.",
    });
    return;
  }
  next();
}
