import { db, usersTable, toolUsageTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

export interface ToolBreakdown {
  toolName: string;
  callCount: number;
  errorCount: number;
  lastCallAt: string | null;
}

export interface UserUsage {
  userId: string;
  name: string;
  email: string | null;
  role: string;
  totalCalls: number;
  totalErrors: number;
  lastCallAt: string | null;
  tools: ToolBreakdown[];
}

export interface FirmUsageDetail {
  totalCalls: number;
  totalErrors: number;
  activeUsers: number;
  users: UserUsage[];
}

/**
 * Builds a per-user, per-tool usage breakdown for a firm in a given month.
 *
 * Every user in the firm is included (even with zero activity) so admins can
 * see who is NOT using the connector, not just who is. Users are sorted by
 * total call volume (most active first); their tool list is sorted the same way.
 */
export async function buildFirmUsageDetail(
  firmId: string,
  year: number,
  month: number,
): Promise<FirmUsageDetail> {
  const [members, usage] = await Promise.all([
    db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        role: usersTable.role,
      })
      .from(usersTable)
      .where(eq(usersTable.firmId, firmId)),
    db
      .select({
        userId: toolUsageTable.userId,
        toolName: toolUsageTable.toolName,
        callCount: toolUsageTable.callCount,
        errorCount: toolUsageTable.errorCount,
        lastCallAt: toolUsageTable.lastCallAt,
      })
      .from(toolUsageTable)
      .where(
        and(
          eq(toolUsageTable.firmId, firmId),
          eq(toolUsageTable.year, year),
          eq(toolUsageTable.month, month),
        ),
      ),
  ]);

  const byUser = new Map<string, UserUsage>();
  for (const m of members) {
    byUser.set(m.id, {
      userId: m.id,
      name: m.name,
      email: m.email,
      role: m.role,
      totalCalls: 0,
      totalErrors: 0,
      lastCallAt: null,
      tools: [],
    });
  }

  for (const row of usage) {
    const u = byUser.get(row.userId);
    if (!u) continue; // user removed from firm but usage retained — skip
    u.totalCalls += row.callCount;
    u.totalErrors += row.errorCount;
    const last = row.lastCallAt ? row.lastCallAt.toISOString() : null;
    if (last && (!u.lastCallAt || last > u.lastCallAt)) u.lastCallAt = last;
    u.tools.push({
      toolName: row.toolName,
      callCount: row.callCount,
      errorCount: row.errorCount,
      lastCallAt: last,
    });
  }

  const users = [...byUser.values()];
  for (const u of users) {
    u.tools.sort((a, b) => b.callCount - a.callCount);
  }
  users.sort((a, b) => b.totalCalls - a.totalCalls);

  return {
    totalCalls: users.reduce((s, u) => s + u.totalCalls, 0),
    totalErrors: users.reduce((s, u) => s + u.totalErrors, 0),
    activeUsers: users.filter((u) => u.totalCalls > 0).length,
    users,
  };
}
