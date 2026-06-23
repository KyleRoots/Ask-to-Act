import { logger } from "./logger.js";

const FROM_EMAIL = "noreply@asktoact.ai";
const FROM_NAME = "AskToAct";

function inviteHtml(opts: {
  userName: string;
  firmName: string;
  enrollUrl: string;
  baseUrl: string;
}): string {
  const { userName, firmName, enrollUrl, baseUrl } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>You're invited to ${firmName}'s AskToAct workspace</title>
</head>
<body style="margin:0;padding:0;background:#0b1020;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0b1020;padding:40px 20px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

      <!-- Logo -->
      <tr><td style="padding-bottom:32px;">
        <table cellpadding="0" cellspacing="0">
          <tr>
            <td style="width:10px;height:10px;border-radius:50%;background:#38bdf8;vertical-align:middle;"></td>
            <td style="padding-left:8px;font-size:18px;font-weight:700;color:#f8fafc;letter-spacing:-0.01em;vertical-align:middle;">AskToAct</td>
          </tr>
        </table>
      </td></tr>

      <!-- Card -->
      <tr><td style="background:#141927;border:1px solid #1e2a3a;border-radius:16px;padding:40px;">

        <p style="margin:0 0 8px;font-size:13px;color:#38bdf8;letter-spacing:0.12em;text-transform:uppercase;font-weight:600;">
          Workspace Invitation
        </p>

        <h1 style="margin:0 0 20px;font-size:26px;font-weight:800;color:#f8fafc;line-height:1.2;letter-spacing:-0.02em;">
          Hi ${userName},
        </h1>

        <p style="margin:0 0 16px;font-size:16px;color:#cbd5e1;line-height:1.6;">
          <strong style="color:#f8fafc;">${firmName}</strong> has set you up on AskToAct —
          the AI connector that gives your ChatGPT or Claude direct, permission-aware access
          to Bullhorn, acting as you.
        </p>

        <p style="margin:0 0 28px;font-size:16px;color:#cbd5e1;line-height:1.6;">
          To get started, connect your Bullhorn account. It takes about 30 seconds.
        </p>

        <!-- CTA -->
        <table cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
          <tr>
            <td style="background:linear-gradient(135deg,#4F46E5,#0EA5E9);border-radius:10px;">
              <a href="${enrollUrl}"
                 style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;letter-spacing:-0.01em;">
                Connect Bullhorn Account →
              </a>
            </td>
          </tr>
        </table>

        <div style="border-top:1px solid #1e2a3a;padding-top:24px;">
          <p style="margin:0 0 8px;font-size:13px;color:#4a5568;">
            After connecting, you'll receive your personal connector URL. Paste it into
            ChatGPT or Claude under <strong style="color:#6b7a99;">Settings → Connectors</strong>
            and you're live.
          </p>
          <p style="margin:0;font-size:12px;color:#2d3748;">
            Or copy the link manually: <span style="color:#38bdf8;word-break:break-all;">${enrollUrl}</span>
          </p>
        </div>
      </td></tr>

      <!-- Footer -->
      <tr><td style="padding-top:24px;">
        <p style="margin:0;font-size:12px;color:#2d3748;text-align:center;">
          AskToAct · <a href="${baseUrl}" style="color:#38bdf8;text-decoration:none;">${baseUrl.replace(/^https?:\/\//, "")}</a>
          &nbsp;·&nbsp; If you didn't expect this invitation, you can safely ignore it.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

export interface InvitePayload {
  toEmail: string;
  userName: string;
  firmName: string;
  enrollUrl: string;
  baseUrl: string;
}

export async function sendInviteEmail(payload: InvitePayload): Promise<void> {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    logger.warn({ toEmail: payload.toEmail }, "SENDGRID_API_KEY not set — invite email skipped");
    return;
  }

  const sgMail = await import("@sendgrid/mail");
  sgMail.default.setApiKey(apiKey);

  await sgMail.default.send({
    to: { name: payload.userName, email: payload.toEmail },
    from: { name: FROM_NAME, email: FROM_EMAIL },
    subject: `You've been invited to ${payload.firmName}'s AskToAct workspace`,
    html: inviteHtml(payload),
    text: [
      `Hi ${payload.userName},`,
      ``,
      `${payload.firmName} has set you up on AskToAct — the AI connector that gives your ChatGPT or Claude direct access to Bullhorn.`,
      ``,
      `Connect your Bullhorn account here (takes ~30 seconds):`,
      payload.enrollUrl,
      ``,
      `After connecting you'll receive your personal connector URL for ChatGPT / Claude.`,
      ``,
      `— AskToAct`,
    ].join("\n"),
  });
}

export interface SupportPayload {
  userEmail: string;
  userName: string;
  type: "bug" | "feature" | "question";
  subject: string;
  message: string;
}

export async function sendSupportEmail(payload: SupportPayload): Promise<void> {
  const apiKey = process.env.SENDGRID_API_KEY;
  const dest = process.env.SUPPORT_EMAIL ?? "support@asktoact.ai";

  if (!apiKey) {
    logger.warn({ userEmail: payload.userEmail }, "SENDGRID_API_KEY not set — support email skipped");
    return;
  }

  const typeLabel: Record<string, string> = {
    bug: "🐛 Bug Report",
    feature: "✨ Feature Request",
    question: "❓ Question",
  };
  const label = typeLabel[payload.type] ?? payload.type;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /></head>
<body style="margin:0;padding:0;background:#0b1020;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0b1020;padding:40px 20px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
      <tr><td style="padding-bottom:24px;">
        <span style="font-size:16px;font-weight:700;color:#f8fafc;">AskToAct</span>
        <span style="font-size:13px;color:#38bdf8;margin-left:10px;">Support Inbox</span>
      </td></tr>
      <tr><td style="background:#141927;border:1px solid #1e2a3a;border-radius:16px;padding:36px;">
        <p style="margin:0 0 6px;font-size:12px;color:#38bdf8;letter-spacing:0.12em;text-transform:uppercase;font-weight:600;">${label}</p>
        <h2 style="margin:0 0 20px;font-size:20px;font-weight:700;color:#f8fafc;">${payload.subject}</h2>
        <p style="margin:0 0 20px;font-size:15px;color:#cbd5e1;line-height:1.7;white-space:pre-wrap;">${payload.message}</p>
        <div style="border-top:1px solid #1e2a3a;padding-top:20px;font-size:13px;color:#4a5568;">
          <strong style="color:#94a3b8;">From:</strong> ${payload.userName} &lt;${payload.userEmail}&gt;
        </div>
      </td></tr>
      <tr><td style="padding-top:20px;font-size:11px;color:#2d3748;text-align:center;">
        Submitted via AskToAct customer portal · Reply directly to this email to respond to ${payload.userName}
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  const sgMail = await import("@sendgrid/mail");
  sgMail.default.setApiKey(apiKey);

  await sgMail.default.send({
    to: dest,
    from: { name: FROM_NAME, email: FROM_EMAIL },
    replyTo: { name: payload.userName, email: payload.userEmail },
    subject: `[${label}] ${payload.subject}`,
    html,
    text: `${label}: ${payload.subject}\n\nFrom: ${payload.userName} <${payload.userEmail}>\n\n${payload.message}`,
  });
}

export async function sendBulkInvites(payloads: InvitePayload[]): Promise<{
  sent: number;
  skipped: number;
  errors: { email: string; error: string }[];
}> {
  let sent = 0;
  let skipped = 0;
  const errors: { email: string; error: string }[] = [];

  for (const payload of payloads) {
    try {
      await sendInviteEmail(payload);
      sent++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ toEmail: payload.toEmail, err }, "Failed to send invite email");
      errors.push({ email: payload.toEmail, error: msg });
      skipped++;
    }
  }

  return { sent, skipped, errors };
}
