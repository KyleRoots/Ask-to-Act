/**
 * Lightweight in-process ops health poller (every ~20m by default).
 * Disable with OPS_ALERTS=0. Prefer this over a second Railway cron service.
 */
import { logger } from "./logger.js";
import { opsAlertsEnabled } from "./ops-health.js";
import { runOpsHealthCheckAndMaybeAlert } from "./ops-alerts.js";

const DEFAULT_INTERVAL_MS = 20 * 60 * 1000;
const BOOT_DELAY_MS = 90_000;

let timer: ReturnType<typeof setInterval> | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;
let ticking = false;

function intervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["OPS_HEALTH_INTERVAL_MS"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 60_000) return DEFAULT_INTERVAL_MS;
  return Math.floor(n);
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const { report, delivery } = await runOpsHealthCheckAndMaybeAlert({
      alert: true,
    });
    logger.info(
      {
        status: report.status,
        fingerprint: report.fingerprint,
        issueCount: report.issues.length,
        notified: delivery?.notified ?? false,
        skippedReason: delivery?.skippedReason,
      },
      "Ops health tick",
    );
  } catch (err) {
    logger.error({ err }, "Ops health tick failed");
  } finally {
    ticking = false;
  }
}

/** Start periodic ops health checks (idempotent). */
export function startOpsHealthScheduler(): void {
  if (!opsAlertsEnabled()) {
    logger.info("Ops health scheduler disabled (OPS_ALERTS=0)");
    return;
  }
  if (timer || bootTimer) return;

  const ms = intervalMs();
  bootTimer = setTimeout(() => {
    bootTimer = null;
    void tick();
    timer = setInterval(() => void tick(), ms);
    // Don't keep the event loop alive solely for ops ticks in tests.
    if (typeof timer.unref === "function") timer.unref();
  }, BOOT_DELAY_MS);
  if (typeof bootTimer.unref === "function") bootTimer.unref();

  logger.info(
    { intervalMs: ms, bootDelayMs: BOOT_DELAY_MS },
    "Ops health scheduler started",
  );
}

export function stopOpsHealthScheduler(): void {
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
