import {
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { firmsTable } from "./firms";
import { usersTable } from "./users";

/**
 * In-process async report jobs (no Redis/BullMQ).
 * Persist → HTTP 202 → void run() on the api-server with firm Bullhorn context.
 * Status: queued | running | complete | failed.
 */
export const reportJobsTable = pgTable(
  "report_jobs",
  {
    id: text("id").primaryKey(),
    firmId: text("firm_id")
      .notNull()
      .references(() => firmsTable.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    args: jsonb("args").notNull(),
    status: text("status").notNull().default("queued"),
    result: jsonb("result"),
    errorSummary: text("error_summary"),
    stopReason: text("stop_reason"),
    createdByUserId: text("created_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (table) => [
    index("report_jobs_firm_status_created_idx").on(
      table.firmId,
      table.status,
      table.createdAt,
    ),
  ],
);

export type ReportJob = typeof reportJobsTable.$inferSelect;
export type InsertReportJob = typeof reportJobsTable.$inferInsert;
