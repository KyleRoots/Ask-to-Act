/**
 * Seat activity tracking
 *
 * Records the first AI call per user per calendar month. This drives the
 * "active-seat" billing model: a seat is only billed in months where it
 * makes at least one call through the connector.
 *
 * All writes are fire-and-forget — they never block a tool response.
 */

import { db, usersTable, seatActivityTable, toolUsageTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger.js";

/**
 * Upserts a seat-activity row for the given user in the current calendar month.
 * Increments call_count on subsequent calls within the same month.
 * No-ops if the user has no firm_id (legacy / service caller).
 */
export async function trackSeatActivity(userId: string): Promise<void> {
  try {
    const [user] = await db
      .select({ firmId: usersTable.firmId })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (!user?.firmId) return;

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1; // 1-indexed

    await db
      .insert(seatActivityTable)
      .values({
        userId,
        firmId: user.firmId,
        year,
        month,
        callCount: 1,
        firstCallAt: now,
        lastCallAt: now,
      })
      .onConflictDoUpdate({
        target: [seatActivityTable.userId, seatActivityTable.year, seatActivityTable.month],
        set: {
          callCount: sql`${seatActivityTable.callCount} + 1`,
          lastCallAt: now,
        },
      });
  } catch (err) {
    // Never let tracking errors surface to the caller
    logger.warn({ err, userId }, "seat-activity tracking failed");
  }
}

/**
 * Upserts a per-tool usage row for the given user in the current calendar
 * month. Increments call_count on every call and error_count when the call
 * failed. No-ops if the user has no firm_id (legacy / service caller).
 * Fire-and-forget — never blocks or surfaces errors to the caller.
 */
export async function trackToolUsage(
  userId: string,
  toolName: string,
  isError = false,
): Promise<void> {
  try {
    const [user] = await db
      .select({ firmId: usersTable.firmId })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (!user?.firmId) return;

    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1; // 1-indexed

    await db
      .insert(toolUsageTable)
      .values({
        userId,
        firmId: user.firmId,
        toolName,
        year,
        month,
        callCount: 1,
        errorCount: isError ? 1 : 0,
        firstCallAt: now,
        lastCallAt: now,
      })
      .onConflictDoUpdate({
        target: [
          toolUsageTable.userId,
          toolUsageTable.toolName,
          toolUsageTable.year,
          toolUsageTable.month,
        ],
        set: {
          callCount: sql`${toolUsageTable.callCount} + 1`,
          errorCount: sql`${toolUsageTable.errorCount} + ${isError ? 1 : 0}`,
          lastCallAt: now,
        },
      });
  } catch (err) {
    // Never let tracking errors surface to the caller
    logger.warn({ err, userId, toolName }, "tool-usage tracking failed");
  }
}

/**
 * Returns the count of active (billing) seats for a firm in a given month.
 * A seat is "active" if it appears at least once in seat_activity for that period.
 */
export async function countActiveSeats(
  firmId: string,
  year: number,
  month: number,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(seatActivityTable)
    .where(
      sql`${seatActivityTable.firmId} = ${firmId}
          AND ${seatActivityTable.year} = ${year}
          AND ${seatActivityTable.month} = ${month}`,
    );
  return rows[0]?.count ?? 0;
}
