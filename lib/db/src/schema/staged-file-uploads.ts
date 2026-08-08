import {
  pgTable,
  text,
  timestamp,
  integer,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { firmsTable } from "./firms";
import { usersTable } from "./users";

/** Postgres bytea ↔ Node Buffer for staged chat-file uploads. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Short-lived firm/user-scoped file staging for MCP hosts that cannot (or will
 * not) send multi-hundred-KB base64 inline. Browser or authenticated clients
 * PUT raw bytes; upload_file_to_record / create_candidate_from_resume consume
 * via fileRef and clear content.
 */
export const stagedFileUploadsTable = pgTable(
  "staged_file_uploads",
  {
    id: text("id").primaryKey(),
    firmId: text("firm_id")
      .notNull()
      .references(() => firmsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** Opaque token embedded in the one-time browser upload URL. */
    uploadToken: text("upload_token").notNull().unique(),
    fileName: text("file_name"),
    contentType: text("content_type"),
    content: bytea("content"),
    sizeBytes: integer("size_bytes"),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("staged_file_uploads_firm_user_idx").on(t.firmId, t.userId),
    index("staged_file_uploads_expires_at_idx").on(t.expiresAt),
  ],
);

export type StagedFileUpload = typeof stagedFileUploadsTable.$inferSelect;
export type InsertStagedFileUpload = typeof stagedFileUploadsTable.$inferInsert;
