/**
 * Automatic one-click Bullhorn reconnect emails for recruiters whose personal
 * OAuth refresh token has died. Cooldown prevents spam if GPT retries writes.
 */
import { db, usersTable, firmsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import {
  reconnectEmailCooldownMs,
  shouldSendReconnectEmail,
} from "./user-reconnect-notify-helpers.js";
import {
  claimReconnectNotice,
  completeReconnectNotice,
  currentRefreshGeneration,
} from "./bullhorn-refresh-coordinator.js";

export {
  RECONNECT_EMAIL_COOLDOWN_DEFAULT_MS,
  reconnectEmailCooldownMs,
  shouldSendReconnectEmail,
} from "./user-reconnect-notify-helpers.js";

/**
 * Emails the recruiter a one-click reconnect link if cooldown allows.
 * Never throws — notify failures must not mask BullhornReconnectRequiredError.
 */
export async function maybeSendUserReconnectEmail(opts: {
  userId: string;
  connectUrl: string;
  expectedGeneration?: number;
  nowMs?: number;
}): Promise<{ sent: boolean; state?: "claimed" | "accepted" | "failed" | "unknown"; skippedReason?: string }> {
  const nowMs = opts.nowMs ?? Date.now();
  const cooldownMs = reconnectEmailCooldownMs();
  const attemptId = randomUUID();

  try {
    const [user] = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
        firmId: usersTable.firmId,
        reconnectEmailSentAt: usersTable.reconnectEmailSentAt,
      })
      .from(usersTable)
      .where(eq(usersTable.id, opts.userId))
      .limit(1);

    if (!user?.email) {
      return { sent: false, skippedReason: "no_email" };
    }

    if (
      !shouldSendReconnectEmail({
        lastSentAt: user.reconnectEmailSentAt,
        nowMs,
        cooldownMs,
      })
    ) {
      return { sent: false, skippedReason: "cooldown" };
    }

    const expectedGeneration =
      opts.expectedGeneration ?? (await currentRefreshGeneration("user", opts.userId));
    if (expectedGeneration === null) {
      return { sent: false, skippedReason: "missing_generation" };
    }
    const claimed = await claimReconnectNotice({
      kind: "user",
      id: opts.userId,
      expectedGeneration,
      attemptId,
      now: new Date(nowMs),
    });
    if (!claimed) {
      return { sent: false, state: "claimed", skippedReason: "not_claimed" };
    }

    let firmName = "your organization";
    if (user.firmId) {
      const [firm] = await db
        .select({ name: firmsTable.name })
        .from(firmsTable)
        .where(eq(firmsTable.id, user.firmId))
        .limit(1);
      if (firm?.name) firmName = firm.name;
    }

    const { sendReconnectEmail } = await import("./emailService.js");
    try {
      await sendReconnectEmail({
        toEmail: user.email,
        userName: user.name,
        firmName,
        enrollUrl: opts.connectUrl,
      });
    } catch (err) {
      const completedFailed = await completeReconnectNotice({
        kind: "user",
        id: opts.userId,
        expectedGeneration,
        attemptId,
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
        now: new Date(nowMs),
      });
      if (completedFailed) {
        return { sent: false, state: "failed", skippedReason: "send_failed" };
      }
      throw err;
    }

    const completed = await completeReconnectNotice({
      kind: "user",
      id: opts.userId,
      expectedGeneration,
      attemptId,
      state: "accepted",
      now: new Date(nowMs),
    });
    if (!completed) {
      logger.warn(
        { userId: opts.userId },
        "Bullhorn: reconnect email accepted by mailer but notice completion was superseded",
      );
      return { sent: true, state: "unknown", skippedReason: "completion_superseded" };
    }

    await db
      .update(usersTable)
      .set({
        reconnectEmailSentAt: new Date(nowMs),
        updatedAt: new Date(nowMs),
      })
      .where(
        sql`${usersTable.id} = ${opts.userId}
          AND bullhorn_refresh_generation = ${expectedGeneration}
          AND bullhorn_reconnect_notice_attempt_id = ${attemptId}`,
      );

    logger.info(
      { userId: opts.userId, email: user.email },
      "Bullhorn: automatic reconnect email sent",
    );
    return { sent: true, state: "accepted" };
  } catch (err) {
    logger.error(
      { userId: opts.userId, err },
      "Bullhorn: failed to send automatic reconnect email",
    );
    return { sent: false, skippedReason: "send_failed" };
  }
}
