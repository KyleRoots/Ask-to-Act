import { db, bullhornTokensTable, usersTable } from "@workspace/db";
import { isNotNull } from "drizzle-orm";
import { logger } from "./logger.js";
import { getSession, getUserSession } from "./bullhorn-auth.js";
import { bullhornAuthRefreshEnabled } from "./bullhorn-auth-refresh-helpers.js";

export { bullhornAuthRefreshEnabled } from "./bullhorn-auth-refresh-helpers.js";
export type ProactiveAuthRefreshResult = {
  firmsAttempted: number;
  firmsOk: number;
  firmsFailed: number;
  usersAttempted: number;
  usersOk: number;
  usersFailed: number;
};

const DEFAULT_USER_GAP_MS = 250;

function userGapMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["BULLHORN_AUTH_REFRESH_USER_GAP_MS"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_USER_GAP_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_USER_GAP_MS;
  return Math.floor(n);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Refresh every connected firm session and every enrolled recruiter session.
 * Safe to run periodically — getSession/getUserSession no-op when still fresh.
 */
export async function runProactiveBullhornAuthRefresh(): Promise<ProactiveAuthRefreshResult> {
  if (!bullhornAuthRefreshEnabled()) {
    return {
      firmsAttempted: 0,
      firmsOk: 0,
      firmsFailed: 0,
      usersAttempted: 0,
      usersOk: 0,
      usersFailed: 0,
    };
  }

  const result: ProactiveAuthRefreshResult = {
    firmsAttempted: 0,
    firmsOk: 0,
    firmsFailed: 0,
    usersAttempted: 0,
    usersOk: 0,
    usersFailed: 0,
  };

  const firmRows = await db
    .select({ firmId: bullhornTokensTable.firmId })
    .from(bullhornTokensTable)
    .where(isNotNull(bullhornTokensTable.firmId));

  for (const row of firmRows) {
    const firmId = row.firmId;
    if (!firmId) continue;
    result.firmsAttempted += 1;
    try {
      await getSession(firmId);
      result.firmsOk += 1;
    } catch (err) {
      result.firmsFailed += 1;
      logger.warn(
        { firmId, err },
        "Bullhorn proactive refresh: firm session failed",
      );
    }
  }

  const userRows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(isNotNull(usersTable.refreshToken));

  const gap = userGapMs();
  for (let i = 0; i < userRows.length; i++) {
    const userId = userRows[i]!.id;
    result.usersAttempted += 1;
    try {
      await getUserSession(userId);
      result.usersOk += 1;
    } catch (err) {
      result.usersFailed += 1;
      // getUserSession already emails + throws BullhornReconnectRequiredError
      logger.warn(
        { userId, err: err instanceof Error ? err.message : String(err) },
        "Bullhorn proactive refresh: user session failed (reconnect notified if due)",
      );
    }
    if (gap > 0 && i < userRows.length - 1) {
      await sleep(gap);
    }
  }

  logger.info({ ...result }, "Bullhorn proactive auth refresh complete");
  return result;
}
