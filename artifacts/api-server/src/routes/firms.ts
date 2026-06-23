import { Router, type IRouter, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { db, firmsTable, usersTable, seatActivityTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { bearerAuth } from "../middlewares/bearer-auth.js";
import { stripeStorage } from "../lib/stripe/storage.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

/**
 * POST /api/firms
 * Admin-only. Creates a firm and, if Stripe is connected, a Stripe customer
 * and checkout session for the Platform Plan.
 * Body: { name: string, seatLimit?: number }
 */
router.post("/firms", bearerAuth, async (req: Request, res: Response) => {
  const { name, seatLimit } = req.body as {
    name?: string;
    seatLimit?: number;
  };

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const id = randomBytes(8).toString("hex");

  try {
    await db.insert(firmsTable).values({
      id,
      name: name.trim(),
      seatLimit: seatLimit ?? null,
    });
    logger.info({ firmId: id, name: name.trim() }, "Firm created");

    // Attempt to create a Stripe customer + checkout session if Stripe is connected
    let checkoutUrl: string | null = null;
    let stripeCustomerId: string | null = null;

    try {
      const { getUncachableStripeClient } = await import(
        "../lib/stripe/stripeClient.js"
      );
      const stripe = await getUncachableStripeClient();

      const customer = await stripe.customers.create({
        name: name.trim(),
        metadata: { firmId: id },
      });
      stripeCustomerId = customer.id;

      await db
        .update(firmsTable)
        .set({ stripeCustomerId })
        .where(eq(firmsTable.id, id));

      // Look up the Platform Plan price
      const prices = await stripe.prices.search({
        query: "product_name:'AskToAct Platform' AND active:'true'",
      });
      const priceId = prices.data[0]?.id;

      if (priceId) {
        const baseUrl =
          process.env.NODE_ENV === "production"
            ? `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`
            : `http://localhost:${process.env.PORT}`;

        const session = await stripe.checkout.sessions.create({
          customer: customer.id,
          payment_method_types: ["card"],
          line_items: [{ price: priceId, quantity: 1 }],
          mode: "subscription",
          subscription_data: {
            metadata: { firmId: id, seatLimit: String(seatLimit ?? 10) },
          },
          success_url: `${baseUrl}/api/firms/${id}?subscribed=1`,
          cancel_url: `${baseUrl}/api/firms/${id}?canceled=1`,
        });
        checkoutUrl = session.url;
      }
    } catch (stripeErr: unknown) {
      const msg = stripeErr instanceof Error ? stripeErr.message : String(stripeErr);
      logger.warn(
        { firmId: id, error: msg },
        "Stripe not connected — firm created without billing. Connect Stripe to enable subscription.",
      );
    }

    res.status(201).json({
      id,
      name: name.trim(),
      seatLimit: seatLimit ?? null,
      stripeCustomerId,
      checkoutUrl,
      message: checkoutUrl
        ? "Firm created. Share the checkoutUrl with the firm admin to complete payment."
        : "Firm created (no Stripe billing — connect Stripe integration to enable subscriptions).",
    });
  } catch (err) {
    logger.error({ err }, "Failed to create firm");
    res.status(500).json({ error: "Failed to create firm" });
  }
});

/**
 * GET /api/firms/:id
 * Admin-only. Returns firm details, live subscription status, and seat usage.
 */
router.get("/firms/:id", bearerAuth, async (req: Request, res: Response) => {
  const { id } = req.params;

  const [firm] = await db
    .select()
    .from(firmsTable)
    .where(eq(firmsTable.id, id));

  if (!firm) {
    res.status(404).json({ error: "Firm not found" });
    return;
  }

  const userCount = await stripeStorage.countFirmUsers(id);
  const subscriptionStatus = await stripeStorage.resolveFirmStatus(id);

  res.json({
    id: firm.id,
    name: firm.name,
    stripeCustomerId: firm.stripeCustomerId,
    stripeSubscriptionId: firm.stripeSubscriptionId,
    subscriptionStatus,
    seatLimit: firm.seatLimit,
    enrolledSeats: userCount,
    seatsRemaining:
      firm.seatLimit != null ? firm.seatLimit - userCount : "unlimited",
    createdAt: firm.createdAt,
  });
});

/**
 * GET /api/firms
 * Admin-only. List all firms.
 */
router.get("/firms", bearerAuth, async (_req: Request, res: Response) => {
  const firms = await db.select().from(firmsTable);
  const rows = await Promise.all(
    firms.map(async (f) => ({
      id: f.id,
      name: f.name,
      subscriptionStatus: f.subscriptionStatus ?? "none",
      enrolledSeats: await stripeStorage.countFirmUsers(f.id),
      seatLimit: f.seatLimit,
    })),
  );
  res.json({ data: rows });
});

/**
 * GET /api/firms/:id/users
 * Admin-only. List users enrolled under a firm.
 */
router.get(
  "/firms/:id/users",
  bearerAuth,
  async (req: Request, res: Response) => {
    const { id } = req.params;

    const [firm] = await db
      .select({ id: firmsTable.id })
      .from(firmsTable)
      .where(eq(firmsTable.id, id));

    if (!firm) {
      res.status(404).json({ error: "Firm not found" });
      return;
    }

    const users = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        role: usersTable.role,
        enrolled: usersTable.refreshToken,
        createdAt: usersTable.createdAt,
      })
      .from(usersTable)
      .where(eq(usersTable.firmId, id));

    res.json({
      data: users.map((u) => ({
        ...u,
        enrolled: u.enrolled != null,
      })),
    });
  },
);

/**
 * POST /api/firms/:id/billing-portal
 * Admin-only. Returns a Stripe billing portal URL for managing subscription.
 */
router.post(
  "/firms/:id/billing-portal",
  bearerAuth,
  async (req: Request, res: Response) => {
    const { id } = req.params;

    const [firm] = await db
      .select()
      .from(firmsTable)
      .where(eq(firmsTable.id, id));

    if (!firm?.stripeCustomerId) {
      res.status(400).json({
        error: "Firm has no Stripe customer. Complete checkout first.",
      });
      return;
    }

    try {
      const { getUncachableStripeClient } = await import(
        "../lib/stripe/stripeClient.js"
      );
      const stripe = await getUncachableStripeClient();

      const baseUrl =
        process.env.NODE_ENV === "production"
          ? `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`
          : `http://localhost:${process.env.PORT}`;

      const session = await stripe.billingPortal.sessions.create({
        customer: firm.stripeCustomerId,
        return_url: `${baseUrl}/api/firms/${id}`,
      });

      res.json({ url: session.url });
    } catch (err) {
      logger.error({ err }, "Failed to create billing portal session");
      res.status(500).json({ error: "Stripe not available" });
    }
  },
);

/**
 * POST /api/firms/:id/activate
 * Admin-only. Manually activates a firm as a pilot/complimentary account —
 * sets subscription_status = 'active' without requiring a Stripe checkout.
 * Use this to onboard a free pilot customer before billing is live.
 * Body: { seatLimit?: number, note?: string }
 */
router.post(
  "/firms/:id/activate",
  bearerAuth,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { seatLimit, note } = req.body as {
      seatLimit?: number;
      note?: string;
    };

    const [firm] = await db
      .select()
      .from(firmsTable)
      .where(eq(firmsTable.id, id));

    if (!firm) {
      res.status(404).json({ error: "Firm not found" });
      return;
    }

    const update: Partial<typeof firmsTable.$inferInsert> = {
      subscriptionStatus: "active",
      updatedAt: new Date(),
    };
    if (seatLimit != null) update.seatLimit = seatLimit;

    await db.update(firmsTable).set(update).where(eq(firmsTable.id, id));

    logger.info(
      { firmId: id, seatLimit: seatLimit ?? firm.seatLimit, note: note ?? "pilot" },
      "Firm manually activated as pilot",
    );

    res.json({
      id,
      name: firm.name,
      subscriptionStatus: "active",
      seatLimit: seatLimit ?? firm.seatLimit,
      pilotNote: note ?? "Manually activated — no Stripe subscription",
      message: `Firm '${firm.name}' is now active. You can add users via POST /api/users with firmId=${id}.`,
    });
  },
);

/**
 * GET /api/firms/:id/usage
 * Admin-only. Monthly active-seat counts for the firm (last 24 months).
 */
router.get(
  "/firms/:id/usage",
  bearerAuth,
  async (req: Request, res: Response) => {
    const { id } = req.params;

    const [firm] = await db
      .select({ id: firmsTable.id })
      .from(firmsTable)
      .where(eq(firmsTable.id, id));

    if (!firm) {
      res.status(404).json({ error: "Firm not found" });
      return;
    }

    const rows = await db
      .select({
        year: seatActivityTable.year,
        month: seatActivityTable.month,
        userId: seatActivityTable.userId,
        callCount: seatActivityTable.callCount,
      })
      .from(seatActivityTable)
      .where(eq(seatActivityTable.firmId, id));

    // Group by year+month → count distinct active users + total calls
    const byMonth: Record<
      string,
      { year: number; month: number; activeSeats: number; totalCalls: number }
    > = {};
    for (const row of rows) {
      const key = `${row.year}-${String(row.month).padStart(2, "0")}`;
      if (!byMonth[key]) {
        byMonth[key] = { year: row.year, month: row.month, activeSeats: 0, totalCalls: 0 };
      }
      byMonth[key].activeSeats++;
      byMonth[key].totalCalls += row.callCount;
    }

    const data = Object.values(byMonth).sort((a, b) =>
      a.year !== b.year ? a.year - b.year : a.month - b.month,
    );

    res.json({ data });
  },
);

export default router;
