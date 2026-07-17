import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("sentry optional init", () => {
  const prev = process.env["SENTRY_DSN"];

  beforeEach(() => {
    delete process.env["SENTRY_DSN"];
  });

  afterEach(() => {
    if (prev === undefined) delete process.env["SENTRY_DSN"];
    else process.env["SENTRY_DSN"] = prev;
  });

  it("is disabled when SENTRY_DSN is unset", async () => {
    // Fresh import against a clean env — the module reads process.env at call time.
    const { isSentryEnabled, initSentry, captureException } = await import(
      "./sentry.js"
    );
    initSentry();
    expect(isSentryEnabled()).toBe(false);
    // Must not throw when disabled.
    expect(() => captureException(new Error("noop"))).not.toThrow();
  });
});
