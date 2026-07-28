import { createHash, randomBytes } from "node:crypto";
import type { BullhornWriteSession } from "./bullhorn-client.js";
import { getUserMailboxStatus, getMailboxConnectUrlForUser } from "./m365-auth.js";
import {
  previewEmailToRecord,
  sendEmailToRecord,
  type EmailEntityType,
} from "./send-email-to-record.js";

/** Hard cap for bulk email v1 — adjustable later based on demand. */
export const BULK_EMAIL_MAX_RECIPIENTS = 50;

const CONFIRM_TTL_MS = 10 * 60 * 1000;

export type BulkRecipientRef = {
  entityType: EmailEntityType;
  recordId: number;
};

type ConfirmEntry = {
  userId: string;
  subject: string;
  body: string;
  jobOrderId?: number;
  recipients: BulkRecipientRef[];
  fingerprint: string;
  expiresAt: number;
};

const pendingConfirms = new Map<string, ConfirmEntry>();

function pruneExpiredConfirms(now = Date.now()): void {
  for (const [token, entry] of pendingConfirms) {
    if (entry.expiresAt <= now) pendingConfirms.delete(token);
  }
}

function normalizeRecipients(recipients: BulkRecipientRef[]): BulkRecipientRef[] {
  const seen = new Set<string>();
  const out: BulkRecipientRef[] = [];
  for (const r of recipients) {
    const key = `${r.entityType}:${r.recordId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ entityType: r.entityType, recordId: r.recordId });
  }
  return out;
}

function fingerprintPayload(args: {
  subject: string;
  body: string;
  jobOrderId?: number;
  recipients: BulkRecipientRef[];
}): string {
  const normalized = [...args.recipients]
    .map((r) => `${r.entityType}:${r.recordId}`)
    .sort()
    .join(",");
  return createHash("sha256")
    .update(
      JSON.stringify({
        subject: args.subject,
        body: args.body,
        jobOrderId: args.jobOrderId ?? null,
        recipients: normalized,
      }),
    )
    .digest("hex");
}

function mintConfirmToken(entry: Omit<ConfirmEntry, "expiresAt">): {
  confirmToken: string;
  expiresAt: string;
} {
  pruneExpiredConfirms();
  const confirmToken = randomBytes(24).toString("hex");
  const expiresAtMs = Date.now() + CONFIRM_TTL_MS;
  pendingConfirms.set(confirmToken, { ...entry, expiresAt: expiresAtMs });
  return {
    confirmToken,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function consumeConfirmToken(args: {
  confirmToken: string;
  userId: string;
  subject: string;
  body: string;
  jobOrderId?: number;
  recipients: BulkRecipientRef[];
}): { ok: true; entry: ConfirmEntry } | { ok: false; error: string; message: string } {
  pruneExpiredConfirms();
  const entry = pendingConfirms.get(args.confirmToken);
  if (!entry) {
    return {
      ok: false,
      error: "confirm_required",
      message:
        "Live bulk send requires a confirmToken from a recent dryRun preview. Re-run with dryRun=true, show the preview table, then confirm with the returned confirmToken.",
    };
  }
  if (entry.expiresAt <= Date.now()) {
    pendingConfirms.delete(args.confirmToken);
    return {
      ok: false,
      error: "confirm_expired",
      message:
        "The bulk confirmToken expired. Re-run dryRun=true to get a fresh preview and confirmToken.",
    };
  }
  if (entry.userId !== args.userId) {
    return {
      ok: false,
      error: "confirm_mismatch",
      message: "confirmToken does not belong to this AskToAct user.",
    };
  }
  const fingerprint = fingerprintPayload({
    subject: args.subject,
    body: args.body,
    jobOrderId: args.jobOrderId,
    recipients: args.recipients,
  });
  if (fingerprint !== entry.fingerprint) {
    return {
      ok: false,
      error: "confirm_mismatch",
      message:
        "Recipients, subject, body, or jobOrderId changed since preview. Re-run dryRun=true and confirm the new preview before sending.",
    };
  }
  pendingConfirms.delete(args.confirmToken);
  return { ok: true, entry };
}

/** Test helper — clears in-memory confirm tokens. */
export function clearBulkEmailConfirmTokensForTests(): void {
  pendingConfirms.clear();
}

export async function previewEmailsToRecords(args: {
  userId: string;
  recipients: BulkRecipientRef[];
  subject: string;
  body: string;
  jobOrderId?: number;
}) {
  const recipients = normalizeRecipients(args.recipients);
  if (recipients.length === 0) {
    return {
      ok: false as const,
      error: "validation_error",
      message: "At least one recipient is required.",
    };
  }
  if (recipients.length > BULK_EMAIL_MAX_RECIPIENTS) {
    return {
      ok: false as const,
      error: "too_many_recipients",
      message: `Bulk email is capped at ${BULK_EMAIL_MAX_RECIPIENTS} recipients per run. Split the list or shrink to ${BULK_EMAIL_MAX_RECIPIENTS} or fewer.`,
      maxAllowed: BULK_EMAIL_MAX_RECIPIENTS,
      requested: recipients.length,
    };
  }

  const ready: Array<{
    entityType: EmailEntityType;
    recordId: number;
    name: string;
    email: string;
    status: string;
    bullhornUrl: string | null;
  }> = [];
  const skipped: Array<{
    entityType: EmailEntityType;
    recordId: number;
    name?: string;
    email?: string | null;
    status?: string;
    bullhornUrl?: string | null;
    error: string;
    message: string;
  }> = [];

  for (const recipient of recipients) {
    const preview = await previewEmailToRecord({
      userId: args.userId,
      entityType: recipient.entityType,
      recordId: recipient.recordId,
      subject: args.subject,
      body: args.body,
      jobOrderId: args.jobOrderId,
    });
    if (!preview.ok) {
      skipped.push({
        entityType: recipient.entityType,
        recordId: recipient.recordId,
        name: preview.recipient?.name,
        email: preview.recipient?.email ?? null,
        status: preview.recipient?.status,
        bullhornUrl: preview.recipient?.bullhornUrl ?? null,
        error: preview.error ?? "skipped",
        message: preview.message ?? "Recipient was skipped.",
      });
      continue;
    }
    ready.push({
      entityType: preview.recipient.entityType,
      recordId: preview.recipient.recordId,
      name: preview.recipient.name,
      email: preview.recipient.email!,
      status: preview.recipient.status,
      bullhornUrl: preview.recipient.bullhornUrl,
    });
  }

  const mailbox = await getUserMailboxStatus(args.userId);
  const connectUrl = mailbox.connected
    ? null
    : await getMailboxConnectUrlForUser(args.userId);

  let confirmToken: string | null = null;
  let expiresAt: string | null = null;
  if (ready.length > 0 && mailbox.connected) {
    const readyRefs = ready.map((r) => ({
      entityType: r.entityType,
      recordId: r.recordId,
    }));
    // Fingerprint the full requested list so GPT can confirm with the same
    // recipients array it previewed; send loop still uses ready only.
    const minted = mintConfirmToken({
      userId: args.userId,
      subject: args.subject,
      body: args.body,
      jobOrderId: args.jobOrderId,
      recipients: readyRefs,
      fingerprint: fingerprintPayload({
        subject: args.subject,
        body: args.body,
        jobOrderId: args.jobOrderId,
        recipients,
      }),
    });
    confirmToken = minted.confirmToken;
    expiresAt = minted.expiresAt;
  }

  return {
    ok: true as const,
    dryRun: true,
    maxAllowed: BULK_EMAIL_MAX_RECIPIENTS,
    batchSize: recipients.length,
    readyCount: ready.length,
    skippedCount: skipped.length,
    ready,
    skipped,
    mailboxConnected: mailbox.connected,
    mailboxEmail: mailbox.mailboxEmail,
    connectUrl,
    subject: args.subject,
    bodyPreview:
      args.body.length > 1000 ? `${args.body.slice(0, 1000)}...` : args.body,
    jobOrderId: args.jobOrderId ?? null,
    confirmToken,
    expiresAt,
    message:
      ready.length === 0
        ? "No recipients are ready to send. Fix skipped rows or choose different records, then preview again."
        : !mailbox.connected
          ? "Mailbox is not connected. Open connectUrl, finish Microsoft 365 sign-in, then re-run dryRun=true before confirming."
          : `Preview ready for ${ready.length} recipient(s). Show the ready/skipped tables in chat (link each NAME via bullhornUrl; leave emails as plain text). Do NOT use ChatGPT's native draft Send card. After the user confirms, call again with the SAME recipients/subject/body, dryRun=false, and this confirmToken.`,
  };
}

export async function sendEmailsToRecords(args: {
  userId: string;
  bullhornSession: BullhornWriteSession;
  recipients: BulkRecipientRef[];
  subject: string;
  body: string;
  jobOrderId?: number;
  confirmToken: string;
}) {
  const recipients = normalizeRecipients(args.recipients);
  if (recipients.length === 0) {
    return {
      ok: false as const,
      error: "validation_error",
      message: "At least one recipient is required.",
    };
  }
  if (recipients.length > BULK_EMAIL_MAX_RECIPIENTS) {
    return {
      ok: false as const,
      error: "too_many_recipients",
      message: `Bulk email is capped at ${BULK_EMAIL_MAX_RECIPIENTS} recipients per run.`,
      maxAllowed: BULK_EMAIL_MAX_RECIPIENTS,
      requested: recipients.length,
    };
  }

  // Check mailbox before consuming the confirmToken so a disconnect doesn't
  // force a full re-preview just to recover the token.
  const mailbox = await getUserMailboxStatus(args.userId);
  if (!mailbox.connected) {
    return {
      ok: false as const,
      error: "mailbox_not_connected",
      message:
        "Microsoft 365 mailbox is not connected. Open connectUrl, finish sign-in, then re-run dryRun=true.",
      connectUrl: await getMailboxConnectUrlForUser(args.userId),
      sent: [],
      failed: [],
      skipped: [],
      stoppedEarly: true,
    };
  }

  const confirmed = consumeConfirmToken({
    confirmToken: args.confirmToken,
    userId: args.userId,
    subject: args.subject,
    body: args.body,
    jobOrderId: args.jobOrderId,
    recipients,
  });
  if (!confirmed.ok) {
    return {
      ok: false as const,
      error: confirmed.error,
      message: confirmed.message,
    };
  }

  const sent: Array<Record<string, unknown>> = [];
  const failed: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  let stoppedEarly = false;
  let stopReason: string | null = null;

  for (const recipient of confirmed.entry.recipients) {
    const result = await sendEmailToRecord({
      userId: args.userId,
      bullhornSession: args.bullhornSession,
      entityType: recipient.entityType,
      recordId: recipient.recordId,
      subject: args.subject,
      body: args.body,
      jobOrderId: args.jobOrderId,
    });

    if (result.ok && "logId" in result) {
      sent.push({
        entityType: recipient.entityType,
        recordId: recipient.recordId,
        recipient: result.recipient,
        logId: result.logId,
        bullhornNoteId: result.bullhornNoteId,
        senderEmail: result.senderEmail,
      });
      continue;
    }

    if (!result.ok) {
      if (
        result.error === "mailbox_not_connected" ||
        result.error === "mailbox_reconnect_required"
      ) {
        failed.push({
          entityType: recipient.entityType,
          recordId: recipient.recordId,
          recipient: "recipient" in result ? result.recipient : undefined,
          error: result.error,
          message: result.message,
          connectUrl: "connectUrl" in result ? result.connectUrl : undefined,
        });
        stoppedEarly = true;
        stopReason = result.error;
        break;
      }

      if (result.error === "missing_email" || result.error === "do_not_contact") {
        skipped.push({
          entityType: recipient.entityType,
          recordId: recipient.recordId,
          recipient: "recipient" in result ? result.recipient : undefined,
          error: result.error,
          message: result.message,
        });
        continue;
      }

      failed.push({
        entityType: recipient.entityType,
        recordId: recipient.recordId,
        recipient: "recipient" in result ? result.recipient : undefined,
        error: result.error,
        message: result.message,
      });
    }
  }

  return {
    ok: true as const,
    dryRun: false,
    maxAllowed: BULK_EMAIL_MAX_RECIPIENTS,
    sentCount: sent.length,
    failedCount: failed.length,
    skippedCount: skipped.length,
    sent,
    failed,
    skipped,
    stoppedEarly,
    stopReason,
    subject: args.subject,
    jobOrderId: args.jobOrderId ?? null,
    mailboxEmail: mailbox.mailboxEmail,
    message: stoppedEarly
      ? `Stopped early after ${sent.length} sent (${stopReason}). Fix mailbox/Bullhorn auth, then preview and confirm the remaining recipients.`
      : `Bulk send finished: ${sent.length} sent, ${failed.length} failed, ${skipped.length} skipped. Render each successful recipient NAME as a Markdown link to recipient.bullhornUrl; leave emails as plain text. Do not use ChatGPT's native draft Send card.`,
  };
}
