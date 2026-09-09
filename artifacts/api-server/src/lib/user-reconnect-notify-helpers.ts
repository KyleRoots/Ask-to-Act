/** Pure helpers for automatic Bullhorn reconnect email cooldown (no DB). */

/** Default 24h between automatic reconnect emails for the same user. */
export const RECONNECT_EMAIL_COOLDOWN_DEFAULT_MS = 24 * 60 * 60 * 1000;

export function reconnectEmailCooldownMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env["RECONNECT_EMAIL_COOLDOWN_HOURS"];
  if (raw === undefined || raw.trim() === "") {
    return RECONNECT_EMAIL_COOLDOWN_DEFAULT_MS;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return RECONNECT_EMAIL_COOLDOWN_DEFAULT_MS;
  return Math.floor(n * 60 * 60 * 1000);
}

/** Pure helper — true when we should send another automatic reconnect email. */
export function shouldSendReconnectEmail(opts: {
  lastSentAt: Date | null | undefined;
  nowMs: number;
  cooldownMs: number;
}): boolean {
  if (!opts.lastSentAt) return true;
  return opts.nowMs - opts.lastSentAt.getTime() >= opts.cooldownMs;
}
