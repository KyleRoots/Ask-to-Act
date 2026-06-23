import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const bullhornTokensTable = pgTable("bullhorn_tokens", {
  id: text("id").primaryKey(),
  refreshToken: text("refresh_token").notNull(),
  firmId: text("firm_id"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertBullhornTokenSchema = createInsertSchema(bullhornTokensTable);
export type InsertBullhornToken = z.infer<typeof insertBullhornTokenSchema>;
export type BullhornToken = typeof bullhornTokensTable.$inferSelect;
