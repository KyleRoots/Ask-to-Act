import { createHash, randomBytes } from "node:crypto";
import { db, emailSendLogsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";

export type EmailSendLogStatus =
  | "pending"
  | "send_attempted"
  | "sent"
  | "send_failed"
  | "bullhorn_logged"
  | "bullhorn_log_failed";

function previewBody(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  return normalized.length > 500 ? `${normalized.slice(0, 497)}...` : normalized;
}

function hashBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

async function firmIdForUser(userId: string): Promise<string> {
  const [user] = await db
    .select({ firmId: usersTable.firmId })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!user?.firmId) {
    throw new Error(`User ${userId} is not associated with a firm.`);
  }
  return user.firmId;
}

export async function createEmailSendLog(args: {
  userId: string;
  provider: string;
  entityType: string;
  recordId: number;
  jobOrderId?: number;
  recipientEmail: string;
  subject: string;
  body: string;
}): Promise<string> {
  const id = randomBytes(16).toString("hex");
  const firmId = await firmIdForUser(args.userId);
  await db.insert(emailSendLogsTable).values({
    id,
    userId: args.userId,
    firmId,
    provider: args.provider,
    entityType: args.entityType,
    recordId: args.recordId,
    jobOrderId: args.jobOrderId ?? null,
    recipientEmail: args.recipientEmail,
    subject: args.subject,
    bodyPreview: previewBody(args.body),
    bodyHash: hashBody(args.body),
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

export async function markEmailSendAttempted(logId: string): Promise<void> {
  await db
    .update(emailSendLogsTable)
    .set({
      status: "send_attempted",
      sendAttemptedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(emailSendLogsTable.id, logId));
}

export async function markEmailSendSucceeded(args: {
  logId: string;
  providerMessageId?: string | null;
  internetMessageId?: string | null;
}): Promise<void> {
  await db
    .update(emailSendLogsTable)
    .set({
      status: "sent",
      providerMessageId: args.providerMessageId ?? null,
      internetMessageId: args.internetMessageId ?? null,
      sentAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(emailSendLogsTable.id, args.logId));
}

export async function markEmailSendFailed(args: {
  logId: string;
  errorCategory: string;
  errorMessage: string;
}): Promise<void> {
  await db
    .update(emailSendLogsTable)
    .set({
      status: "send_failed",
      errorCategory: args.errorCategory,
      errorMessage: args.errorMessage.slice(0, 2000),
      updatedAt: new Date(),
    })
    .where(eq(emailSendLogsTable.id, args.logId));
}

export async function markEmailBullhornLogged(args: {
  logId: string;
  bullhornNoteId: number;
}): Promise<void> {
  await db
    .update(emailSendLogsTable)
    .set({
      status: "bullhorn_logged",
      bullhornNoteId: args.bullhornNoteId,
      bullhornLoggedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(emailSendLogsTable.id, args.logId));
}

export async function markEmailBullhornLogFailed(args: {
  logId: string;
  errorMessage: string;
}): Promise<void> {
  await db
    .update(emailSendLogsTable)
    .set({
      status: "bullhorn_log_failed",
      errorCategory: "bullhorn_note_failed",
      errorMessage: args.errorMessage.slice(0, 2000),
      updatedAt: new Date(),
    })
    .where(eq(emailSendLogsTable.id, args.logId));
}

export async function safeMarkEmailSendFailed(args: {
  logId: string;
  errorCategory: string;
  errorMessage: string;
}): Promise<void> {
  try {
    await markEmailSendFailed(args);
  } catch (err) {
    logger.warn({ err, logId: args.logId }, "email send log failure update failed");
  }
}
