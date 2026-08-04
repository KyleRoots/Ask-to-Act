import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Dedupe / cooldown state for ops health alerts.
 * One row per issue fingerprint; last_sent_at gates re-alerts.
 */
export const opsAlertStateTable = pgTable("ops_alert_state", {
  fingerprint: text("fingerprint").primaryKey(),
  severity: text("severity").notNull(),
  lastSentAt: timestamp("last_sent_at").notNull(),
  summary: text("summary"),
});

export type OpsAlertState = typeof opsAlertStateTable.$inferSelect;
export type InsertOpsAlertState = typeof opsAlertStateTable.$inferInsert;
