import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  addNote,
  type BullhornWriteSession,
  getCandidate,
  getContact,
} from "./bullhorn-client.js";
import {
  createEmailSendLog,
  markEmailBullhornLogFailed,
  markEmailBullhornLogged,
  markEmailSendAttempted,
  markEmailSendSucceeded,
  safeMarkEmailSendFailed,
} from "./email-send-log.js";
import {
  MailboxNotConnectedError,
  MailboxReconnectRequiredError,
  getMailboxConnectUrlForUser,
  getUserMailboxStatus,
} from "./m365-auth.js";
import { MailSendError, sendMailViaMicrosoft365 } from "./m365-mail.js";
import { entityOf, str } from "./record-utils.js";

export type EmailEntityType = "Candidate" | "ClientContact";

const STATUS_DNC_MARKERS = [
  "do not contact",
  "do-not-contact",
  "dnc",
  "opted out",
  "opt out",
  "opt-out",
] as const;

type ResolvedRecipient = {
  entityType: EmailEntityType;
  recordId: number;
  name: string;
  email: string | null;
  status: string;
  bullhornUrl: string | null;
};

function nameFromEntity(entity: Record<string, unknown>, fallback: string): string {
  const explicit = str(entity.name);
  if (explicit) return explicit;
  const first = str(entity.firstName);
  const last = str(entity.lastName);
  return `${first} ${last}`.trim() || fallback;
}

function isDoNotContactStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return STATUS_DNC_MARKERS.some((marker) => normalized.includes(marker));
}

async function resolveRecipient(
  entityType: EmailEntityType,
  recordId: number,
): Promise<ResolvedRecipient> {
  const raw =
    entityType === "Candidate"
      ? await getCandidate({ id: recordId, fields: "id,firstName,lastName,name,email,status" })
      : await getContact({ id: recordId, fields: "id,firstName,lastName,name,email,status" });
  const entity = entityOf(raw);
  const id = Number(entity.id);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error(`${entityType} ${recordId} was not found or is not readable.`);
  }
  return {
    entityType,
    recordId: id,
    name: nameFromEntity(entity, `${entityType} ${recordId}`),
    email: str(entity.email) || null,
    status: str(entity.status),
    bullhornUrl:
      typeof entity.bullhornUrl === "string" ? entity.bullhornUrl : null,
  };
}

async function senderDisplay(userId: string): Promise<string> {
  const [user] = await db
    .select({ name: usersTable.name, email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!user) return userId;
  return user.email ? `${user.name} <${user.email}>` : user.name;
}

function buildAuditNote(args: {
  senderEmail: string;
  senderDisplay: string;
  recipientName: string;
  recipientEmail: string;
  subject: string;
  body: string;
  jobOrderId?: number;
}): string {
  const excerpt = args.body.replace(/\s+/g, " ").trim();
  const summary = excerpt.length > 400 ? `${excerpt.slice(0, 397)}...` : excerpt;
  return [
    "Outbound email sent via AskToAct / Microsoft 365",
    `To: ${args.recipientName} <${args.recipientEmail}>`,
    `From mailbox: ${args.senderEmail}`,
    `Recruiter: ${args.senderDisplay}`,
    `Subject: ${args.subject}`,
    `Sent at: ${new Date().toISOString()}`,
    args.jobOrderId ? `Related Job ID: ${args.jobOrderId}` : null,
    `Summary: ${summary}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function previewEmailToRecord(args: {
  userId: string;
  entityType: EmailEntityType;
  recordId: number;
  subject: string;
  body: string;
  jobOrderId?: number;
}) {
  const recipient = await resolveRecipient(args.entityType, args.recordId);
  if (!recipient.email) {
    return {
      ok: false,
      error: "missing_email",
      message: `${recipient.name} does not have an email address on the Bullhorn record.`,
      recipient,
    };
  }
  if (isDoNotContactStatus(recipient.status)) {
    return {
      ok: false,
      error: "do_not_contact",
      message: `${recipient.name} is marked with a do-not-contact / opt-out style status in Bullhorn (${recipient.status}).`,
      recipient,
    };
  }
  const mailbox = await getUserMailboxStatus(args.userId);
  return {
    ok: true,
    recipient,
    mailboxConnected: mailbox.connected,
    mailboxEmail: mailbox.mailboxEmail,
    connectUrl: mailbox.connected
      ? null
      : await getMailboxConnectUrlForUser(args.userId),
    subject: args.subject,
    bodyPreview:
      args.body.length > 1000 ? `${args.body.slice(0, 1000)}...` : args.body,
    jobOrderId: args.jobOrderId ?? null,
  };
}

export async function sendEmailToRecord(args: {
  userId: string;
  bullhornSession: BullhornWriteSession;
  entityType: EmailEntityType;
  recordId: number;
  subject: string;
  body: string;
  jobOrderId?: number;
}) {
  const preview = await previewEmailToRecord(args);
  if (!preview.ok) return preview;

  const logId = await createEmailSendLog({
    userId: args.userId,
    provider: "microsoft365",
    entityType: args.entityType,
    recordId: args.recordId,
    jobOrderId: args.jobOrderId,
    recipientEmail: preview.recipient.email!,
    subject: args.subject,
    body: args.body,
  });
  await markEmailSendAttempted(logId);

  try {
    const sent = await sendMailViaMicrosoft365({
      userId: args.userId,
      recipientEmail: preview.recipient.email!,
      subject: args.subject,
      body: args.body,
    });
    await markEmailSendSucceeded({
      logId,
      providerMessageId: sent.providerMessageId,
      internetMessageId: sent.internetMessageId,
    });

    const note = await addNote(args.bullhornSession, {
      action: "Email",
      comments: buildAuditNote({
        senderEmail: sent.senderEmail,
        senderDisplay: await senderDisplay(args.userId),
        recipientName: preview.recipient.name,
        recipientEmail: preview.recipient.email!,
        subject: args.subject,
        body: args.body,
        jobOrderId: args.jobOrderId,
      }),
      candidateId:
        args.entityType === "Candidate" ? args.recordId : undefined,
      clientContactId:
        args.entityType === "ClientContact" ? args.recordId : undefined,
      jobOrderId: args.jobOrderId,
    });
    await markEmailBullhornLogged({ logId, bullhornNoteId: note.noteId });

    return {
      ok: true,
      entityType: args.entityType,
      recordId: args.recordId,
      recipient: preview.recipient,
      senderEmail: sent.senderEmail,
      subject: args.subject,
      logId,
      bullhornNoteId: note.noteId,
      provider: sent.provider,
      providerMessageId: sent.providerMessageId,
      internetMessageId: sent.internetMessageId,
    };
  } catch (err) {
    if (err instanceof MailboxNotConnectedError) {
      await safeMarkEmailSendFailed({
        logId,
        errorCategory: "mailbox_not_connected",
        errorMessage: err.message,
      });
      return {
        ok: false,
        error: "mailbox_not_connected",
        message: err.message,
        connectUrl: err.connectUrl,
        recipient: preview.recipient,
      };
    }
    if (err instanceof MailboxReconnectRequiredError) {
      await safeMarkEmailSendFailed({
        logId,
        errorCategory: "mailbox_reconnect_required",
        errorMessage: err.message,
      });
      return {
        ok: false,
        error: "mailbox_reconnect_required",
        message: err.message,
        connectUrl: err.connectUrl,
        recipient: preview.recipient,
      };
    }
    if (err instanceof MailSendError) {
      await safeMarkEmailSendFailed({
        logId,
        errorCategory: err.category,
        errorMessage: err.message,
      });
      return {
        ok: false,
        error: err.category,
        message: err.message,
        recipient: preview.recipient,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    await safeMarkEmailSendFailed({
      logId,
      errorCategory: "unexpected_error",
      errorMessage: message,
    });
    try {
      await markEmailBullhornLogFailed({
        logId,
        errorMessage: message,
      });
    } catch {
      // Best effort only.
    }
    throw err;
  }
}
