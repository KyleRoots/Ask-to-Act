import {
  pgTable,
  text,
  integer,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { firmsTable } from "./firms";
import { usersTable } from "./users";

export const emailSendLogsTable = pgTable(
  "email_send_logs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    firmId: text("firm_id")
      .notNull()
      .references(() => firmsTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    entityType: text("entity_type").notNull(),
    recordId: integer("record_id").notNull(),
    jobOrderId: integer("job_order_id"),
    recipientEmail: text("recipient_email").notNull(),
    subject: text("subject").notNull(),
    bodyPreview: text("body_preview"),
    bodyHash: text("body_hash"),
    status: text("status").notNull(),
    providerMessageId: text("provider_message_id"),
    internetMessageId: text("internet_message_id"),
    bullhornNoteId: integer("bullhorn_note_id"),
    errorCategory: text("error_category"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    sendAttemptedAt: timestamp("send_attempted_at"),
    sentAt: timestamp("sent_at"),
    bullhornLoggedAt: timestamp("bullhorn_logged_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("email_send_logs_user_id_idx").on(table.userId),
    index("email_send_logs_firm_id_idx").on(table.firmId),
    index("email_send_logs_entity_idx").on(table.entityType, table.recordId),
    index("email_send_logs_status_idx").on(table.status),
  ],
);

export type EmailSendLog = typeof emailSendLogsTable.$inferSelect;
