/**
 * In-process proactive Bullhorn OAuth refresh (default every ~60m).
 * Disable with BULLHORN_AUTH_REFRESH=0.
 */
import { logger } from "./logger.js";
import { bullhornAuthRefreshEnabled } from "./bullhorn-auth-refresh-helpers.js";
import { runProactiveBullhornAuthRefresh } from "./bullhorn-auth-refresh.js";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const BOOT_DELAY_MS = 3 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;
let ticking = false;

function intervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["BULLHORN_AUTH_REFRESH_INTERVAL_MS"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  // Floor at 5 minutes so a bad env cannot hammer Bullhorn.
  if (!Number.isFinite(n) || n < 5 * 60 * 1000) return DEFAULT_INTERVAL_MS;
  return Math.floor(n);
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const result = await runProactiveBullhornAuthRefresh();
    logger.info(
      {
        firmsOk: result.firmsOk,
        firmsFailed: result.firmsFailed,
        usersOk: result.usersOk,
        usersFailed: result.usersFailed,
      },
      "Bullhorn auth refresh tick",
    );
  } catch (err) {
    logger.error({ err }, "Bullhorn auth refresh tick failed");
  } finally {
    ticking = false;
  }
}

/** Start periodic proactive OAuth refresh (idempotent). */
export function startBullhornAuthRefreshScheduler(): void {
  if (!bullhornAuthRefreshEnabled()) {
    logger.info("Bullhorn auth refresh scheduler disabled (BULLHORN_AUTH_REFRESH=0)");
    return;
  }
  if (timer || bootTimer) return;

  const ms = intervalMs();
  bootTimer = setTimeout(() => {
    bootTimer = null;
    void tick();
    timer = setInterval(() => void tick(), ms);
    if (typeof timer.unref === "function") timer.unref();
  }, BOOT_DELAY_MS);
  if (typeof bootTimer.unref === "function") bootTimer.unref();

  logger.info(
    { intervalMs: ms, bootDelayMs: BOOT_DELAY_MS },
    "Bullhorn auth refresh scheduler started",
  );
}

export function stopBullhornAuthRefreshScheduler(): void {
  if (bootTimer) {
    clearTimeout(bootTimer);
    bootTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
