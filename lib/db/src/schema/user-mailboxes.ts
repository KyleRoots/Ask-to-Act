import {
  pgTable,
  text,
  timestamp,
  bigint,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const userMailboxesTable = pgTable(
  "user_mailboxes",
  {
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    mailboxEmail: text("mailbox_email"),
    refreshToken: text("refresh_token"),
    accessToken: text("access_token"),
    tokenExpiresAt: bigint("token_expires_at", { mode: "number" }),
    scope: text("scope"),
    connectToken: text("connect_token").unique(),
    connectTokenExpiresAt: timestamp("connect_token_expires_at"),
    connectedAt: timestamp("connected_at"),
    revokedAt: timestamp("revoked_at"),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.provider] }),
    index("user_mailboxes_provider_idx").on(table.provider),
    index("user_mailboxes_connect_token_idx").on(table.connectToken),
  ],
);

export type UserMailbox = typeof userMailboxesTable.$inferSelect;
