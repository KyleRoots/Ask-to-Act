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
import {
  type EmailMergeField,
  type EmailMergeValues,
  mergeValuesFromRecord,
  parseEmailTemplates,
  renderEmail,
  usedMergeValues,
} from "./email-merge-fields.js";
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

const PREVIEW_BODY_MAX_CHARS = 1000;

function previewText(body: string): string {
  return body.length > PREVIEW_BODY_MAX_CHARS
    ? `${body.slice(0, PREVIEW_BODY_MAX_CHARS)}...`
    : body;
}

const MERGE_FIELD_LABELS: Record<EmailMergeField, string> = {
  firstName: "first name",
  lastName: "last name",
  fullName: "name",
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
): Promise<{ recipient: ResolvedRecipient; mergeValues: EmailMergeValues }> {
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
    recipient: {
      entityType,
      recordId: id,
      name: nameFromEntity(entity, `${entityType} ${recordId}`),
      email: str(entity.email) || null,
      status: str(entity.status),
      bullhornUrl:
        typeof entity.bullhornUrl === "string" ? entity.bullhornUrl : null,
    },
    mergeValues: mergeValuesFromRecord(entity),
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

/**
 * Resolves one recipient from Bullhorn and renders the subject/body templates
 * with that record's merge values. Does not send. Template errors return
 * before any Bullhorn read.
 */
export async function previewEmailToRecord(args: {
  userId: string;
  entityType: EmailEntityType;
  recordId: number;
  subject: string;
  body: string;
  jobOrderId?: number;
}) {
  const template = parseEmailTemplates({ subject: args.subject, body: args.body });
  if (!template.ok) {
    return {
      ok: false as const,
      error: template.error,
      message: template.message,
      tags: template.tags,
      recipient: undefined,
    };
  }
  const { recipient, mergeValues } = await resolveRecipient(args.entityType, args.recordId);
  if (!recipient.email) {
    return {
      ok: false as const,
      error: "missing_email",
      message: `${recipient.name} does not have an email address on the Bullhorn record.`,
      recipient,
    };
  }
  if (isDoNotContactStatus(recipient.status)) {
    return {
      ok: false as const,
      error: "do_not_contact",
      message: `${recipient.name} is marked with a do-not-contact / opt-out style status in Bullhorn (${recipient.status}).`,
      recipient,
    };
  }
  const fields = template.parsed.fields;
  const rendered = renderEmail(template.parsed, mergeValues);
  if (!rendered.ok) {
    const missing = rendered.missingFields
      .map((f) => `{{${f}}} (${MERGE_FIELD_LABELS[f]})`)
      .join(", ");
    return {
      ok: false as const,
      error: "missing_merge_value",
      message: `${recipient.name} has no Bullhorn value for ${missing} and the template has no fallback. Add a fallback such as {{${rendered.missingFields[0]}|there}} or leave this recipient out.`,
      missingFields: rendered.missingFields,
      recipient,
    };
  }
  const mailbox = await getUserMailboxStatus(args.userId);
  return {
    ok: true as const,
    recipient,
    mailboxConnected: mailbox.connected,
    mailboxEmail: mailbox.mailboxEmail,
    connectUrl: mailbox.connected
      ? null
      : await getMailboxConnectUrlForUser(args.userId),
    subject: rendered.subject,
    bodyPreview: previewText(rendered.body),
    renderedBody: rendered.body,
    template: {
      subject: args.subject,
      bodyPreview: previewText(args.body),
    },
    mergeFieldsUsed: fields,
    mergeValues: usedMergeValues(mergeValues, fields),
    usedFallback: rendered.usedFallback,
    jobOrderId: args.jobOrderId ?? null,
  };
}

export type PreparedEmail = {
  recipient: ResolvedRecipient & { email: string };
  subject: string;
  body: string;
};

/**
 * Sends one already-rendered email, then writes the ledger row and the
 * Bullhorn Email note with that same rendered subject and body.
 */
export async function deliverPreparedEmail(args: {
  userId: string;
  bullhornSession: BullhornWriteSession;
  prepared: PreparedEmail;
  jobOrderId?: number;
}) {
  const { recipient, subject, body } = args.prepared;
  const logId = await createEmailSendLog({
    userId: args.userId,
    provider: "microsoft365",
    entityType: recipient.entityType,
    recordId: recipient.recordId,
    jobOrderId: args.jobOrderId,
    recipientEmail: recipient.email,
    subject,
    body,
  });
  await markEmailSendAttempted(logId);

  try {
    const sent = await sendMailViaMicrosoft365({
      userId: args.userId,
      recipientEmail: recipient.email,
      subject,
      body,
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
        recipientName: recipient.name,
        recipientEmail: recipient.email,
        subject,
        body,
        jobOrderId: args.jobOrderId,
      }),
      candidateId:
        recipient.entityType === "Candidate" ? recipient.recordId : undefined,
      clientContactId:
        recipient.entityType === "ClientContact" ? recipient.recordId : undefined,
      jobOrderId: args.jobOrderId,
    });
    await markEmailBullhornLogged({ logId, bullhornNoteId: note.noteId });

    return {
      ok: true as const,
      entityType: recipient.entityType,
      recordId: recipient.recordId,
      recipient,
      senderEmail: sent.senderEmail,
      subject,
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
        ok: false as const,
        error: "mailbox_not_connected",
        message: err.message,
        connectUrl: err.connectUrl,
        recipient,
      };
    }
    if (err instanceof MailboxReconnectRequiredError) {
      await safeMarkEmailSendFailed({
        logId,
        errorCategory: "mailbox_reconnect_required",
        errorMessage: err.message,
      });
      return {
        ok: false as const,
        error: "mailbox_reconnect_required",
        message: err.message,
        connectUrl: err.connectUrl,
        recipient,
      };
    }
    if (err instanceof MailSendError) {
      await safeMarkEmailSendFailed({
        logId,
        errorCategory: err.category,
        errorMessage: err.message,
      });
      return {
        ok: false as const,
        error: err.category,
        message: err.message,
        recipient,
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
  return deliverPreparedEmail({
    userId: args.userId,
    bullhornSession: args.bullhornSession,
    prepared: {
      recipient: { ...preview.recipient, email: preview.recipient.email! },
      subject: preview.subject,
      body: preview.renderedBody,
    },
    jobOrderId: args.jobOrderId,
  });
}
