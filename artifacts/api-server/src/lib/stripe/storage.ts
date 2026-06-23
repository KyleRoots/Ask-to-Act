import { db, firmsTable, usersTable } from "@workspace/db";
import { eq, sql, count } from "drizzle-orm";

export class StripeStorage {
  /**
   * Look up a Stripe subscription record from the stripe-replit-sync schema.
   * Returns null if the stripe schema hasn't been created yet (Stripe not connected).
   */
  async getSubscription(subscriptionId: string) {
    try {
      const result = await db.execute(
        sql`SELECT id, status, current_period_end, metadata
            FROM stripe.subscriptions
            WHERE id = ${subscriptionId}`,
      );
      return result.rows[0] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Count enrolled users belonging to a specific firm.
   */
  async countFirmUsers(firmId: string): Promise<number> {
    const result = await db
      .select({ total: count() })
      .from(usersTable)
      .where(eq(usersTable.firmId, firmId));
    return result[0]?.total ?? 0;
  }

  /**
   * Resolve a firm's live subscription status.
   * Returns 'active' | 'trialing' | 'past_due' | 'canceled' | 'none'
   */
  async resolveFirmStatus(
    firmId: string,
  ): Promise<"active" | "trialing" | "past_due" | "canceled" | "none"> {
    const [firm] = await db
      .select()
      .from(firmsTable)
      .where(eq(firmsTable.id, firmId));

    if (!firm) return "none";

    // Trust the cached status in firms table (kept current via webhook sync)
    const cached = firm.subscriptionStatus as string | null;
    if (cached === "active" || cached === "trialing") return cached;
    if (cached === "past_due") return "past_due";
    if (cached === "canceled") return "canceled";

    // Fall back to live Stripe lookup if we have a subscription ID
    if (firm.stripeSubscriptionId) {
      const sub = await this.getSubscription(firm.stripeSubscriptionId);
      if (sub?.status) return sub.status as "active" | "trialing" | "past_due" | "canceled" | "none";
    }

    return "none";
  }
}

export const stripeStorage = new StripeStorage();
