import { randomUUID } from "node:crypto";
import { db, firmsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  claimReconnectNotice,
  completeReconnectNotice,
} from "./bullhorn-refresh-coordinator.js";
import { logger } from "./logger.js";

export async function maybeSendFirmAuthFailureAlert(opts: {
  firmId: string;
  expectedGeneration: number;
  errorMessage: string;
  nowMs?: number;
}): Promise<{ sent: boolean; state?: "claimed" | "accepted" | "failed" | "unknown"; skippedReason?: string }> {
  const nowMs = opts.nowMs ?? Date.now();
  const attemptId = randomUUID();

  try {
    const claimed = await claimReconnectNotice({
      kind: "firm",
      id: opts.firmId,
      expectedGeneration: opts.expectedGeneration,
      attemptId,
      now: new Date(nowMs),
    });
    if (!claimed) {
      return { sent: false, state: "claimed", skippedReason: "not_claimed" };
    }

    const [firm] = await db
      .select({ name: firmsTable.name })
      .from(firmsTable)
      .where(eq(firmsTable.id, opts.firmId))
      .limit(1);

    const { sendFirmAuthFailureAlert } = await import("./emailService.js");
    try {
      await sendFirmAuthFailureAlert({
        firmId: opts.firmId,
        firmName: firm?.name ?? opts.firmId,
        errorMessage: opts.errorMessage,
      });
    } catch (err) {
      await completeReconnectNotice({
        kind: "firm",
        id: opts.firmId,
        expectedGeneration: opts.expectedGeneration,
        attemptId,
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
        now: new Date(nowMs),
      });
      throw err;
    }

    const completed = await completeReconnectNotice({
      kind: "firm",
      id: opts.firmId,
      expectedGeneration: opts.expectedGeneration,
      attemptId,
      state: "accepted",
      now: new Date(nowMs),
    });
    if (!completed) {
      logger.warn(
        { firmId: opts.firmId },
        "Bullhorn: firm auth alert accepted by mailer but notice completion was superseded",
      );
      return { sent: true, state: "unknown", skippedReason: "completion_superseded" };
    }

    logger.warn({ firmId: opts.firmId }, "Bullhorn auth failure alert emailed to support");
    return { sent: true, state: "accepted" };
  } catch (err) {
    logger.error(
      { firmId: opts.firmId, err },
      "Failed to send Bullhorn firm auth failure alert",
    );
    return { sent: false, state: "failed", skippedReason: "send_failed" };
  }
}
