import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Short-lived OAuth CSRF / correlation state for browser authorize → callback.
 * One-time use; expires after ~15 minutes. Persisted so multi-instance
 * Railway workers share state between /login and /callback.
 */
export const oauthStatesTable = pgTable(
  "oauth_states",
  {
    state: text("state").primaryKey(),
    firmId: text("firm_id"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("oauth_states_expires_at_idx").on(t.expiresAt)],
);

export type OauthState = typeof oauthStatesTable.$inferSelect;
export type InsertOauthState = typeof oauthStatesTable.$inferInsert;
