import { logger } from "./logger.js";

const FROM_EMAIL = process.env["FROM_EMAIL"] ?? "noreply@asktoact.ai";
const FROM_NAME = process.env["FROM_NAME"] ?? "AskToAct";
const PROD_URL = process.env["PROD_URL"] ?? "https://connect.asktoact.ai";

function logoHtml(): string {
  return `<table cellpadding="0" cellspacing="0">
  <tr>
    <td style="vertical-align:middle;">
      <table cellpadding="0" cellspacing="0" style="background-color:#4F46E5;border-radius:8px;width:28px;height:28px;">
        <tr><td align="center" valign="middle">
          <div style="width:10px;height:10px;border-radius:5px;background:#ffffff;"></div>
        </td></tr>
      </table>
    </td>
    <td style="padding-left:10px;font-size:18px;font-weight:700;color:#f8fafc;letter-spacing:-0.01em;vertical-align:middle;">AskToAct</td>
  </tr>
</table>`;
}

function inviteHtml(opts: {
  userName: string;
  firmName: string;
  enrollUrl: string;
}): string {
  const { userName, firmName, enrollUrl } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>You've been invited to ${firmName}'s AskToAct workspace</title>
</head>
<body style="margin:0;padding:0;background:#0b1020;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0b1020;padding:40px 20px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

      <!-- Logo -->
      <tr><td style="padding-bottom:32px;">
        ${logoHtml()}
      </td></tr>

      <!-- Card -->
      <tr><td style="background:#141927;border:1px solid #1e2a3a;border-radius:16px;padding:40px;">

        <p style="margin:0 0 8px;font-size:12px;color:#38bdf8;letter-spacing:0.12em;text-transform:uppercase;font-weight:600;">
          Workspace Invitation
        </p>

        <h1 style="margin:0 0 20px;font-size:26px;font-weight:800;color:#f8fafc;line-height:1.2;letter-spacing:-0.02em;">
          Hi ${userName},
        </h1>

        <p style="margin:0 0 24px;font-size:16px;color:#cbd5e1;line-height:1.6;">
          <strong style="color:#f8fafc;">${firmName}</strong> has set you up on AskToAct, the AI connector
          that lets you bring any AI tool you prefer (e.g., ChatGPT, Claude, Gemini, etc.) and connect
          it directly within Bullhorn so you can use your own AI universally.
        </p>

        <!-- Steps -->
        <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:28px;">
          <tr><td style="background:#0f1622;border:1px solid #1e2a3a;border-radius:12px;padding:20px 24px;">
            <p style="margin:0 0 14px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.1em;">How it works</p>
            <table cellpadding="0" cellspacing="0" width="100%">
              <tr>
                <td style="vertical-align:top;padding-bottom:12px;">
                  <span style="display:inline-block;width:22px;height:22px;border-radius:50%;background:#1e3a5f;font-size:12px;font-weight:700;color:#38bdf8;text-align:center;line-height:22px;">1</span>
                </td>
                <td style="padding-left:12px;padding-bottom:12px;vertical-align:top;font-size:14px;color:#cbd5e1;line-height:1.5;">
                  Click <strong style="color:#f8fafc;">Connect Bullhorn Account</strong> below
                </td>
              </tr>
              <tr>
                <td style="vertical-align:top;padding-bottom:12px;">
                  <span style="display:inline-block;width:22px;height:22px;border-radius:50%;background:#1e3a5f;font-size:12px;font-weight:700;color:#38bdf8;text-align:center;line-height:22px;">2</span>
                </td>
                <td style="padding-left:12px;padding-bottom:12px;vertical-align:top;font-size:14px;color:#cbd5e1;line-height:1.5;">
                  Sign in with your Bullhorn username and password
                </td>
              </tr>
              <tr>
                <td style="vertical-align:top;padding-bottom:12px;">
                  <span style="display:inline-block;width:22px;height:22px;border-radius:50%;background:#1e3a5f;font-size:12px;font-weight:700;color:#38bdf8;text-align:center;line-height:22px;">3</span>
                </td>
                <td style="padding-left:12px;padding-bottom:12px;vertical-align:top;font-size:14px;color:#cbd5e1;line-height:1.5;">
                  Copy your personal connector URL from the confirmation page
                </td>
              </tr>
              <tr>
                <td style="vertical-align:top;">
                  <span style="display:inline-block;width:22px;height:22px;border-radius:50%;background:#1e3a5f;font-size:12px;font-weight:700;color:#38bdf8;text-align:center;line-height:22px;">4</span>
                </td>
                <td style="padding-left:12px;vertical-align:top;font-size:14px;color:#cbd5e1;line-height:1.5;">
                  In your preferred AI tool (ChatGPT, Claude, Gemini, etc.), go to <strong style="color:#f8fafc;">Settings, then Connectors</strong> and paste the URL
                </td>
              </tr>
            </table>
          </td></tr>
        </table>

        <!-- CTA Button -->
        <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:28px;">
          <tr>
            <td align="center" bgcolor="#4F46E5" style="background-color:#4F46E5;border-radius:12px;">
              <a href="${enrollUrl}"
                 style="display:block;padding:16px 28px;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;text-align:center;letter-spacing:-0.01em;border-radius:12px;">
                Connect Bullhorn Account
              </a>
            </td>
          </tr>
        </table>

        <!-- Fallback link -->
        <div style="border-top:1px solid #1e2a3a;padding-top:20px;">
          <p style="margin:0;font-size:12px;color:#4a5568;line-height:1.6;">
            Button not working? Copy and paste this link into your browser:<br />
            <a href="${enrollUrl}" style="color:#38bdf8;word-break:break-all;text-decoration:none;">${enrollUrl}</a>
          </p>
        </div>

      </td></tr>

      <!-- Footer -->
      <tr><td style="padding-top:24px;text-align:center;">
        <p style="margin:0 0 6px;font-size:12px;color:#2d3748;">
          AskToAct &nbsp;·&nbsp;
          <a href="${PROD_URL}" style="color:#38bdf8;text-decoration:none;">connect.asktoact.ai</a>
          &nbsp;·&nbsp; If you did not expect this invitation, you can safely ignore it.
        </p>
        <p style="margin:0;font-size:12px;color:#2d3748;">
          Questions or issues? Email us at <a href="mailto:support@asktoact.ai" style="color:#38bdf8;text-decoration:none;">support@asktoact.ai</a>
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
      `${payload.firmName} has set you up on AskToAct, the AI connector that gives your ChatGPT or Claude direct access to Bullhorn.`,
      ``,
      `Here is how to get started:`,
      ``,
      `1. Open the link below to connect your Bullhorn account`,
      `2. Sign in with your Bullhorn username and password`,
      `3. Copy your personal connector URL from the confirmation page`,
      `4. In ChatGPT or Claude, go to Settings, then Connectors and paste the URL`,
      ``,
      `Connect here (takes about 30 seconds):`,
      payload.enrollUrl,
      ``,
      `Questions? Email support@asktoact.ai`,
      ``,
      `AskToAct Team`,
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
    bug: "Bug Report",
    feature: "Feature Request",
    question: "Question",
  };
  const typeEmoji: Record<string, string> = {
    bug: "🐛",
    feature: "✨",
    question: "❓",
  };
  const label = typeLabel[payload.type] ?? payload.type;
  const emoji = typeEmoji[payload.type] ?? "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /></head>
<body style="margin:0;padding:0;background:#0b1020;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0b1020;padding:40px 20px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

      <!-- Logo -->
      <tr><td style="padding-bottom:24px;">
        <table cellpadding="0" cellspacing="0">
          <tr>
            <td style="vertical-align:middle;">
              <div style="width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#4F46E5,#0EA5E9);display:inline-flex;align-items:center;justify-content:center;">
                <div style="width:10px;height:10px;border-radius:50%;background:#ffffff;"></div>
              </div>
            </td>
            <td style="padding-left:10px;font-size:18px;font-weight:700;color:#f8fafc;letter-spacing:-0.01em;vertical-align:middle;">AskToAct</td>
            <td style="padding-left:12px;font-size:13px;font-weight:500;color:#38bdf8;vertical-align:middle;">Support Inbox</td>
          </tr>
        </table>
      </td></tr>

      <!-- Card -->
      <tr><td style="background:#141927;border:1px solid #1e2a3a;border-radius:16px;padding:36px;">

        <p style="margin:0 0 6px;font-size:12px;color:#38bdf8;letter-spacing:0.12em;text-transform:uppercase;font-weight:600;">
          ${emoji} ${label}
        </p>
        <h2 style="margin:0 0 20px;font-size:20px;font-weight:700;color:#f8fafc;">${payload.subject}</h2>
        <p style="margin:0 0 20px;font-size:15px;color:#cbd5e1;line-height:1.7;white-space:pre-wrap;">${payload.message}</p>

        <div style="border-top:1px solid #1e2a3a;padding-top:20px;">
          <table cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:13px;color:#64748b;padding-right:6px;">From:</td>
              <td style="font-size:13px;color:#94a3b8;font-weight:600;">${payload.userName}</td>
              <td style="font-size:13px;color:#64748b;padding-left:4px;">
                &lt;<a href="mailto:${payload.userEmail}" style="color:#38bdf8;text-decoration:none;">${payload.userEmail}</a>&gt;
              </td>
            </tr>
          </table>
        </div>

      </td></tr>

      <!-- Footer -->
      <tr><td style="padding-top:20px;font-size:11px;color:#2d3748;text-align:center;">
        Submitted via AskToAct customer portal &nbsp;·&nbsp; Reply directly to this email to respond to ${payload.userName}
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
    subject: `[${emoji} ${label}] ${payload.subject}`,
    html,
    text: `${emoji} ${label}: ${payload.subject}\n\nFrom: ${payload.userName} <${payload.userEmail}>\n\n${payload.message}`,
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
