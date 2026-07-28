import { logger } from "./logger.js";
import { getUserMailboxSession } from "./m365-auth.js";

export class MailSendError extends Error {
  constructor(
    public readonly category:
      | "invalid_recipient"
      | "permission_denied"
      | "provider_throttled"
      | "provider_unavailable"
      | "provider_error",
    message: string,
  ) {
    super(message);
    this.name = "MailSendError";
  }
}

function htmlFromPlainText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;"),
    )
    .join("<br>");
}

export async function sendMailViaMicrosoft365(args: {
  userId: string;
  recipientEmail: string;
  subject: string;
  body: string;
}): Promise<{
  provider: "microsoft365";
  senderEmail: string;
  providerMessageId: string | null;
  internetMessageId: string | null;
}> {
  const mailbox = await getUserMailboxSession(args.userId);
  const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mailbox.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        subject: args.subject,
        body: {
          contentType: "HTML",
          content: htmlFromPlainText(args.body),
        },
        toRecipients: [
          {
            emailAddress: {
              address: args.recipientEmail,
            },
          },
        ],
      },
      saveToSentItems: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.warn(
      { status: res.status, body: text.slice(0, 300) },
      "Microsoft Graph sendMail failed",
    );
    if (res.status === 400) {
      throw new MailSendError(
        "invalid_recipient",
        "Microsoft 365 rejected the recipient or message payload.",
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new MailSendError(
        "permission_denied",
        "Microsoft 365 refused to send mail from this mailbox. Reconnect the mailbox or confirm the app has Mail.Send delegated permission.",
      );
    }
    if (res.status === 429) {
      throw new MailSendError(
        "provider_throttled",
        "Microsoft 365 is rate-limiting mail sends right now. Please try again in a moment.",
      );
    }
    if (res.status >= 500) {
      throw new MailSendError(
        "provider_unavailable",
        "Microsoft 365 is temporarily unavailable. Please try again later.",
      );
    }
    throw new MailSendError(
      "provider_error",
      "Microsoft 365 could not send this email.",
    );
  }

  return {
    provider: "microsoft365",
    senderEmail: mailbox.mailboxEmail,
    providerMessageId: null,
    internetMessageId: null,
  };
}
