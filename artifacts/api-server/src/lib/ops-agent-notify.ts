/**
 * Ops agent lifecycle notify: email when an agent starts / completes / fails
 * working an ops problem. Distinct from health warn/critical alerts.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, opsAlertStateTable } from "@workspace/db";
import { logger } from "./logger.js";

const FROM_EMAIL = process.env["FROM_EMAIL"] ?? "noreply@asktoact.ai";
const FROM_NAME = process.env["FROM_NAME"] ?? "AskToAct";

/** Default: skip duplicate "started" for same fingerprint within 15 minutes. */
const STARTED_DEDUPE_DEFAULT_MINUTES = 15;

export const OPS_AGENT_SUMMARY_MAX = 500;
export const OPS_AGENT_DETAILS_MAX = 4000;
export const OPS_AGENT_FINGERPRINT_MAX = 64;

export const opsAgentNotifyPhaseSchema = z.enum([
  "started",
  "completed",
  "failed",
]);

export const opsAgentNotifyBodySchema = z.object({
  phase: opsAgentNotifyPhaseSchema,
  summary: z
    .string()
    .trim()
    .min(1, "summary is required")
    .max(OPS_AGENT_SUMMARY_MAX, `summary max ${OPS_AGENT_SUMMARY_MAX} chars`),
  details: z
    .string()
    .trim()
    .max(OPS_AGENT_DETAILS_MAX, `details max ${OPS_AGENT_DETAILS_MAX} chars`)
    .optional(),
  fingerprint: z
    .string()
    .trim()
    .min(1)
    .max(OPS_AGENT_FINGERPRINT_MAX)
    .optional(),
});

export type OpsAgentNotifyPhase = z.infer<typeof opsAgentNotifyPhaseSchema>;
export type OpsAgentNotifyInput = z.infer<typeof opsAgentNotifyBodySchema>;

export type OpsAgentNotifyResult = {
  ok: true;
  notified: boolean;
  skippedReason?: string;
  phase: OpsAgentNotifyPhase;
  fingerprint: string;
  channels: { email: boolean; log: boolean };
};

export function parseOpsAgentNotifyBody(
  raw: unknown,
):
  | { success: true; data: OpsAgentNotifyInput }
  | { success: false; error: string } {
  const parsed = opsAgentNotifyBodySchema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
      .join("; ");
    return { success: false, error: msg };
  }
  return { success: true, data: parsed.data };
}

export function opsAgentNotifyFingerprint(
  input: OpsAgentNotifyInput,
): string {
  if (input.fingerprint) {
    return `agent:${input.phase}:${input.fingerprint}`;
  }
  const hash = createHash("sha256")
    .update(input.summary.toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return `agent:${input.phase}:${hash}`;
}

export function opsAgentStartedDedupeMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env["OPS_AGENT_NOTIFY_DEDUPE_MINUTES"];
  if (raw === undefined || raw.trim() === "") {
    return STARTED_DEDUPE_DEFAULT_MINUTES * 60 * 1000;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return STARTED_DEDUPE_DEFAULT_MINUTES * 60 * 1000;
  }
  return Math.floor(n * 60 * 1000);
}

function opsAlertEmailDest(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env["OPS_ALERT_EMAIL"]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function subjectForPhase(phase: OpsAgentNotifyPhase): string {
  switch (phase) {
    case "started":
      return "[AskToAct ops] Agent started";
    case "completed":
      return "[AskToAct ops] Agent completed";
    case "failed":
      return "[AskToAct ops] Agent failed";
  }
}

async function loadLastSent(
  fingerprint: string,
): Promise<{ lastSentAt: Date } | null> {
  const [row] = await db
    .select()
    .from(opsAlertStateTable)
    .where(eq(opsAlertStateTable.fingerprint, fingerprint))
    .limit(1);
  if (!row) return null;
  return { lastSentAt: row.lastSentAt };
}

async function recordSent(
  fingerprint: string,
  phase: OpsAgentNotifyPhase,
  summary: string,
  nowMs: number,
): Promise<void> {
  await db
    .insert(opsAlertStateTable)
    .values({
      fingerprint,
      severity: phase,
      lastSentAt: new Date(nowMs),
      summary,
    })
    .onConflictDoUpdate({
      target: opsAlertStateTable.fingerprint,
      set: {
        severity: phase,
        lastSentAt: new Date(nowMs),
        summary,
      },
    });
}

async function sendAgentNotifyEmail(opts: {
  to: string;
  phase: OpsAgentNotifyPhase;
  summary: string;
  details?: string;
  fingerprint: string;
}): Promise<boolean> {
  const apiKey = process.env["SENDGRID_API_KEY"];
  if (!apiKey) {
    logger.warn("SENDGRID_API_KEY not set — ops agent notify email skipped");
    return false;
  }

  const lines = [
    `Phase: ${opts.phase}`,
    `Fingerprint: ${opts.fingerprint}`,
    `Sent: ${new Date().toISOString()}`,
    "",
    opts.summary,
  ];
  if (opts.details) {
    lines.push("", "——— Details ———", opts.details);
  }
  const text = lines.join("\n");
  const html = `<pre style="font-family:ui-monospace,monospace;font-size:13px;white-space:pre-wrap;">${text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")}</pre>`;

  const sgMail = await import("@sendgrid/mail");
  sgMail.default.setApiKey(apiKey);
  await sgMail.default.send({
    to: opts.to,
    from: { name: FROM_NAME, email: FROM_EMAIL },
    subject: subjectForPhase(opts.phase),
    text,
    html,
  });
  return true;
}

/**
 * Send (or skip) an ops-agent lifecycle email.
 * If OPS_ALERT_EMAIL is unset → no-op with clear log (does not throw).
 * Light dedupe: duplicate `started` for the same fingerprint within the window is skipped.
 */
export async function notifyOpsAgent(
  input: OpsAgentNotifyInput,
  nowMs: number = Date.now(),
): Promise<OpsAgentNotifyResult> {
  const fingerprint = opsAgentNotifyFingerprint(input);
  const channels = { email: false, log: false };

  logger.info(
    {
      OPS_AGENT_NOTIFY: true,
      phase: input.phase,
      fingerprint,
      summary: input.summary.slice(0, 200),
    },
    `OPS_AGENT_NOTIFY ${input.phase}`,
  );
  channels.log = true;

  // Dedupe only "started" so agents don't spam while retrying the same issue.
  if (input.phase === "started") {
    const last = await loadLastSent(fingerprint);
    const cooldownMs = opsAgentStartedDedupeMs();
    if (
      last &&
      nowMs - last.lastSentAt.getTime() < cooldownMs
    ) {
      return {
        ok: true,
        notified: false,
        skippedReason: "dedupe",
        phase: input.phase,
        fingerprint,
        channels,
      };
    }
  }

  const emailTo = opsAlertEmailDest();
  if (!emailTo) {
    logger.info(
      "OPS_AGENT_NOTIFY: OPS_ALERT_EMAIL unset — logged only (no email)",
    );
    await recordSent(fingerprint, input.phase, input.summary, nowMs);
    return {
      ok: true,
      notified: false,
      skippedReason: "no_OPS_ALERT_EMAIL",
      phase: input.phase,
      fingerprint,
      channels,
    };
  }

  try {
    channels.email = await sendAgentNotifyEmail({
      to: emailTo,
      phase: input.phase,
      summary: input.summary,
      details: input.details,
      fingerprint,
    });
  } catch (err) {
    logger.error({ err }, "Ops agent notify email failed");
    return {
      ok: true,
      notified: false,
      skippedReason: "email_failed",
      phase: input.phase,
      fingerprint,
      channels,
    };
  }

  await recordSent(fingerprint, input.phase, input.summary, nowMs);

  return {
    ok: true,
    notified: channels.email,
    phase: input.phase,
    fingerprint,
    channels,
  };
}
