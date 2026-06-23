import { pgTable, text, integer, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { firmsTable } from "./firms";
import { usersTable } from "./users";

/**
 * Per-tool usage tracking.
 *
 * Records a monthly aggregate of how many times each user invoked each MCP
 * tool, plus error counts and first/last timestamps. This powers the usage
 * analytics views:
 *   - Super admin: usage across all firms, per user, per tool.
 *   - Company admin: usage scoped to their own firm.
 *
 * Unlike seat_activity (which answers "was this seat active this month?" for
 * billing), this answers "who used what, and how often?" for accountability.
 * Aggregating monthly (rather than logging every call) keeps row growth bounded.
 *
 * All writes are fire-and-forget — they never block a tool response.
 */
export const toolUsageTable = pgTable(
  "tool_usage",
  {
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    firmId: text("firm_id")
      .notNull()
      .references(() => firmsTable.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    callCount: integer("call_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    firstCallAt: timestamp("first_call_at").notNull().defaultNow(),
    lastCallAt: timestamp("last_call_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.toolName, table.year, table.month],
    }),
  ],
);

export type ToolUsage = typeof toolUsageTable.$inferSelect;
