import {
  pgTable,
  text,
  timestamp,
  jsonb,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { firmsTable } from "./firms";
import { usersTable } from "./users";

/**
 * Durable async report jobs (DB lease + in-process poller; no Redis/BullMQ).
 * Persist queued → worker claims with lease → heartbeat → complete/fail.
 * Stale running leases are reclaimed after expiry (survives redeploy).
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
    /** Worker instance id holding the lease (hostname:pid:uuid). */
    leaseOwner: text("lease_owner"),
    /** Soft lease expiry; stale running rows are reclaimable when past this. */
    leaseExpiresAt: timestamp("lease_expires_at"),
    heartbeatAt: timestamp("heartbeat_at"),
    /** Incremented on each claim (including reclaim after crash). */
    attemptCount: integer("attempt_count").notNull().default(0),
  },
  (table) => [
    index("report_jobs_firm_status_created_idx").on(
      table.firmId,
      table.status,
      table.createdAt,
    ),
    index("report_jobs_claim_idx").on(
      table.status,
      table.leaseExpiresAt,
      table.createdAt,
    ),
  ],
);

export type ReportJob = typeof reportJobsTable.$inferSelect;
export type InsertReportJob = typeof reportJobsTable.$inferInsert;
