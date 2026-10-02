import { pgTable, text, timestamp, bigint, index, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { firmsTable } from "./firms";

export const usersTable = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    apiKey: text("api_key").notNull().unique(),
    firmId: text("firm_id").references(() => firmsTable.id, { onDelete: "set null" }),
    role: text("role").notNull().default("recruiter"),
    refreshToken: text("refresh_token"),
    bhRestToken: text("bh_rest_token"),
    restUrl: text("rest_url"),
    tokenExpiresAt: bigint("token_expires_at", { mode: "number" }),
    sessionExpiresAt: bigint("session_expires_at", { mode: "number" }),
    invitedAt: timestamp("invited_at"),
    enrollToken: text("enroll_token").unique(),
    enrollTokenExpiresAt: timestamp("enroll_token_expires_at"),
    /** Last automatic reconnect email — used as a spam cooldown. */
    reconnectEmailSentAt: timestamp("reconnect_email_sent_at"),
    bullhornRefreshGeneration: integer("bullhorn_refresh_generation").notNull().default(0),
    bullhornRefreshOutcome: text("bullhorn_refresh_outcome").notNull().default("idle"),
    bullhornRefreshAttemptId: text("bullhorn_refresh_attempt_id"),
    bullhornRefreshLeaseExpiresAt: timestamp("bullhorn_refresh_lease_expires_at"),
    bullhornRefreshUncertainAt: timestamp("bullhorn_refresh_uncertain_at"),
    bullhornReconnectNoticeState: text("bullhorn_reconnect_notice_state")
      .notNull()
      .default("idle"),
    bullhornReconnectNoticeAttemptId: text("bullhorn_reconnect_notice_attempt_id"),
    bullhornReconnectNoticeClaimedAt: timestamp("bullhorn_reconnect_notice_claimed_at"),
    bullhornReconnectNoticeCompletedAt: timestamp("bullhorn_reconnect_notice_completed_at"),
    bullhornReconnectNoticeError: text("bullhorn_reconnect_notice_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("users_firm_id_idx").on(t.firmId)],
);

export const insertUserSchema = createInsertSchema(usersTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
