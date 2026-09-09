import { describe, it, expect } from "vitest";
import {
  RECONNECT_EMAIL_COOLDOWN_DEFAULT_MS,
  reconnectEmailCooldownMs,
  shouldSendReconnectEmail,
} from "./user-reconnect-notify-helpers.js";

describe("reconnect email cooldown helpers", () => {
  it("defaults to 24h and reads RECONNECT_EMAIL_COOLDOWN_HOURS", () => {
    expect(reconnectEmailCooldownMs({})).toBe(RECONNECT_EMAIL_COOLDOWN_DEFAULT_MS);
    expect(reconnectEmailCooldownMs({ RECONNECT_EMAIL_COOLDOWN_HOURS: "12" })).toBe(
      12 * 60 * 60 * 1000,
    );
    expect(reconnectEmailCooldownMs({ RECONNECT_EMAIL_COOLDOWN_HOURS: "bad" })).toBe(
      RECONNECT_EMAIL_COOLDOWN_DEFAULT_MS,
    );
  });

  it("sends when never emailed, skips inside cooldown, allows after cooldown", () => {
    const now = Date.parse("2026-09-09T18:00:00.000Z");
    const day = 24 * 60 * 60 * 1000;
    expect(
      shouldSendReconnectEmail({ lastSentAt: null, nowMs: now, cooldownMs: day }),
    ).toBe(true);
    expect(
      shouldSendReconnectEmail({
        lastSentAt: new Date(now - 60 * 60 * 1000),
        nowMs: now,
        cooldownMs: day,
      }),
    ).toBe(false);
    expect(
      shouldSendReconnectEmail({
        lastSentAt: new Date(now - day),
        nowMs: now,
        cooldownMs: day,
      }),
    ).toBe(true);
  });
});
