/**
 * Automatic one-click Bullhorn reconnect emails for recruiters whose personal
 * OAuth refresh token has died. Cooldown prevents spam if GPT retries writes.
 */
import { db, usersTable, firmsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";
import {
  reconnectEmailCooldownMs,
  shouldSendReconnectEmail,
} from "./user-reconnect-notify-helpers.js";

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
  nowMs?: number;
}): Promise<{ sent: boolean; skippedReason?: string }> {
  const nowMs = opts.nowMs ?? Date.now();
  const cooldownMs = reconnectEmailCooldownMs();

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
    await sendReconnectEmail({
      toEmail: user.email,
      userName: user.name,
      firmName,
      enrollUrl: opts.connectUrl,
    });

    await db
      .update(usersTable)
      .set({
        reconnectEmailSentAt: new Date(nowMs),
        updatedAt: new Date(nowMs),
      })
      .where(eq(usersTable.id, opts.userId));

    logger.info(
      { userId: opts.userId, email: user.email },
      "Bullhorn: automatic reconnect email sent",
    );
    return { sent: true };
  } catch (err) {
    logger.error(
      { userId: opts.userId, err },
      "Bullhorn: failed to send automatic reconnect email",
    );
    return { sent: false, skippedReason: "send_failed" };
  }
}
