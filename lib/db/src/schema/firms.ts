import { pgTable, text, integer, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Firm lifecycle status, independent of Stripe billing (`subscriptionStatus`):
 *  - "active"    — normal; users can use the AI tools.
 *  - "suspended" — access revoked (e.g. non-payment); reversible. All of the
 *                  firm's users are cut off from the live AI-tool path.
 *  - "archived"  — suspended AND hidden from active admin lists; reversible.
 * Only "active" firms may use the AI tools.
 */
export const FIRM_STATUSES = ["active", "suspended", "archived"] as const;
export type FirmStatus = (typeof FIRM_STATUSES)[number];

export const firmsTable = pgTable(
  "firms",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    subscriptionStatus: text("subscription_status"),
    status: text("status").notNull().default("active"),
    seatLimit: integer("seat_limit"),
    logoUrl: text("logo_url"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "firms_status_check",
      sql`${table.status} IN ('active', 'suspended', 'archived')`,
    ),
  ],
);

export const insertFirmSchema = createInsertSchema(firmsTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertFirm = z.infer<typeof insertFirmSchema>;
export type Firm = typeof firmsTable.$inferSelect;
