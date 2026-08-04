/**
 * Ops alert delivery: SendGrid email + optional webhook + structured OPS_ALERT log.
 * Deduped via ops_alert_state (fingerprint + cooldown).
 */
import { eq } from "drizzle-orm";
import { db, opsAlertStateTable } from "@workspace/db";
import { logger } from "./logger.js";
import {
  type OpsHealthReport,
  type OpsSeverity,
  opsAlertCooldownMs,
  opsAlertsEnabled,
  shouldSendOpsAlert,
} from "./ops-health.js";

const FROM_EMAIL = process.env["FROM_EMAIL"] ?? "noreply@asktoact.ai";
const FROM_NAME = process.env["FROM_NAME"] ?? "AskToAct";

export type OpsAlertDeliveryResult = {
  notified: boolean;
  skippedReason?: string;
  channels: {
    email: boolean;
    webhook: boolean;
    log: boolean;
  };
};

function opsAlertEmailDest(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env["OPS_ALERT_EMAIL"]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function opsAlertWebhookUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env["OPS_ALERT_WEBHOOK_URL"]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

async function loadLastSent(
  fingerprint: string,
): Promise<{ fingerprint: string; lastSentAt: Date } | null> {
  const [row] = await db
    .select()
    .from(opsAlertStateTable)
    .where(eq(opsAlertStateTable.fingerprint, fingerprint))
    .limit(1);
  if (!row) return null;
  return { fingerprint: row.fingerprint, lastSentAt: row.lastSentAt };
}

async function recordAlertSent(
  fingerprint: string,
  severity: OpsSeverity,
  summary: string,
  nowMs: number,
): Promise<void> {
  await db
    .insert(opsAlertStateTable)
    .values({
      fingerprint,
      severity,
      lastSentAt: new Date(nowMs),
      summary,
    })
    .onConflictDoUpdate({
      target: opsAlertStateTable.fingerprint,
      set: {
        severity,
        lastSentAt: new Date(nowMs),
        summary,
      },
    });
}

async function sendOpsAlertEmail(
  report: OpsHealthReport,
  to: string,
): Promise<boolean> {
  const apiKey = process.env["SENDGRID_API_KEY"];
  if (!apiKey) {
    logger.warn("SENDGRID_API_KEY not set — ops alert email skipped");
    return false;
  }

  const subject = `[AskToAct ops ${report.status.toUpperCase()}] ${report.summary.slice(0, 120)}`;
  const text = [
    `Severity: ${report.status}`,
    `Checked: ${report.checkedAt}`,
    `Fingerprint: ${report.fingerprint}`,
    "",
    report.summary,
    "",
    "——— Copy-paste into Cursor ———",
    report.agentBrief,
    "——— end ———",
  ].join("\n");

  const html = `<pre style="font-family:ui-monospace,monospace;font-size:13px;white-space:pre-wrap;">${text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")}</pre>`;

  const sgMail = await import("@sendgrid/mail");
  sgMail.default.setApiKey(apiKey);
  await sgMail.default.send({
    to,
    from: { name: FROM_NAME, email: FROM_EMAIL },
    subject,
    text,
    html,
  });
  return true;
}

async function sendOpsAlertWebhook(
  report: OpsHealthReport,
  url: string,
): Promise<boolean> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "OPS_ALERT",
      status: report.status,
      checkedAt: report.checkedAt,
      fingerprint: report.fingerprint,
      summary: report.summary,
      agentBrief: report.agentBrief,
      issues: report.issues,
      checks: report.checks,
    }),
  });
  if (!res.ok) {
    throw new Error(`OPS_ALERT webhook HTTP ${res.status}`);
  }
  return true;
}

/**
 * Evaluate whether to notify for a report, then email / webhook / structured log.
 * Always emits one OPS_ALERT log line when status is warn|critical (even if cooldown skips email).
 */
export async function maybeNotifyOpsAlert(
  report: OpsHealthReport,
  nowMs: number = Date.now(),
): Promise<OpsAlertDeliveryResult> {
  const channels = { email: false, webhook: false, log: false };

  if (!opsAlertsEnabled()) {
    return { notified: false, skippedReason: "OPS_ALERTS=0", channels };
  }

  if (report.status === "ok") {
    return { notified: false, skippedReason: "status_ok", channels };
  }

  // Always log a single structured line for Railway log drains / grep.
  logger.warn(
    {
      OPS_ALERT: true,
      status: report.status,
      fingerprint: report.fingerprint,
      summary: report.summary,
      issueCodes: report.issues.map((i) => i.code),
      checks: report.checks,
    },
    "OPS_ALERT",
  );
  channels.log = true;

  const lastSent = await loadLastSent(report.fingerprint);
  const cooldownMs = opsAlertCooldownMs();
  const send = shouldSendOpsAlert({
    status: report.status,
    fingerprint: report.fingerprint,
    lastSent,
    cooldownMs,
    nowMs,
  });

  if (!send) {
    return {
      notified: false,
      skippedReason: "cooldown",
      channels,
    };
  }

  const emailTo = opsAlertEmailDest();
  const webhook = opsAlertWebhookUrl();
  let delivered = false;

  if (emailTo) {
    try {
      channels.email = await sendOpsAlertEmail(report, emailTo);
      delivered = delivered || channels.email;
    } catch (err) {
      logger.error({ err }, "Ops alert email failed");
    }
  }

  if (webhook) {
    try {
      channels.webhook = await sendOpsAlertWebhook(report, webhook);
      delivered = delivered || channels.webhook;
    } catch (err) {
      logger.error({ err }, "Ops alert webhook failed");
    }
  }

  if (!emailTo && !webhook) {
    logger.info(
      "OPS_ALERT: no OPS_ALERT_EMAIL or OPS_ALERT_WEBHOOK_URL — logged only",
    );
  }

  // Record cooldown whenever we decided to notify (even if only log), so we
  // don't spam logs every 20m for the same fingerprint. Email/webhook still
  // attempt on that first send window.
  await recordAlertSent(
    report.fingerprint,
    report.status,
    report.summary,
    nowMs,
  );

  return {
    notified: delivered || channels.log,
    channels,
  };
}

/** Run health check + maybe notify. Used by scheduler and ?alert=1. */
export async function runOpsHealthCheckAndMaybeAlert(opts?: {
  alert?: boolean;
  nowMs?: number;
}): Promise<{
  report: OpsHealthReport;
  delivery: OpsAlertDeliveryResult | null;
}> {
  const { evaluateOpsHealthFromDb } = await import("./ops-health.js");
  const nowMs = opts?.nowMs ?? Date.now();
  const report = await evaluateOpsHealthFromDb(nowMs);
  let delivery: OpsAlertDeliveryResult | null = null;
  if (opts?.alert !== false) {
    delivery = await maybeNotifyOpsAlert(report, nowMs);
  }
  return { report, delivery };
}
