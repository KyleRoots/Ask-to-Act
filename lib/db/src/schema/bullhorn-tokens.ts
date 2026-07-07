import { pgTable, text, timestamp, unique, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { firmsTable } from "./firms";

/**
 * Per-firm Bullhorn service connection. One row per customer firm, keyed by
 * `firmId` (unique). `id` is a legacy/opaque primary key — the existing shared
 * connection keeps `id = "default"`; new firms use their firmId as the id.
 *
 * Connection/session material is stored per firm so each customer's Bullhorn
 * is fully isolated:
 *  - `oauthUrl`  — the firm's OAuth base (token exchange/refresh).
 *  - `restUrl`   — the firm's authenticated REST base from its last login.
 *  - `loginUrl`  — the firm's REST /login endpoint (derived from restUrl), used
 *                  on refresh so we never reuse another firm's swimlane.
 *  - `authMode`  — "service" = env-credential headless account (only the
 *                  AskToAct/Myticas firm); "oauth" = interactive OAuth (customer
 *                  firms), which can only re-establish via refresh token.
 */
export const bullhornTokensTable = pgTable(
  "bullhorn_tokens",
  {
    id: text("id").primaryKey(),
    refreshToken: text("refresh_token").notNull(),
    firmId: text("firm_id").references(() => firmsTable.id, {
      onDelete: "cascade",
    }),
    oauthUrl: text("oauth_url"),
    restUrl: text("rest_url"),
    loginUrl: text("login_url"),
    authMode: text("auth_mode").notNull().default("oauth"),
    /** False when OAuth refresh fails for a customer firm — admin must re-authorize. */
    authHealthy: boolean("auth_healthy").notNull().default(true),
    lastAuthErrorAt: timestamp("last_auth_error_at"),
    lastAuthError: text("last_auth_error"),
    connectedAt: timestamp("connected_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [unique("bullhorn_tokens_firm_id_unique").on(table.firmId)],
);

export const insertBullhornTokenSchema = createInsertSchema(bullhornTokensTable);
export type InsertBullhornToken = z.infer<typeof insertBullhornTokenSchema>;
export type BullhornToken = typeof bullhornTokensTable.$inferSelect;
