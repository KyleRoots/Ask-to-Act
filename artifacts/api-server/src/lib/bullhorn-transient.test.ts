import { describe, it, expect } from "vitest";
import {
  isTransientBullhornHttpStatus,
  transientHttpBackoffMs,
  TRANSIENT_HTTP_MAX_RETRIES,
} from "./bullhorn-transient.js";

describe("bullhorn-transient", () => {
  it("treats 502/503/504 as transient and not 4xx/500", () => {
    expect(isTransientBullhornHttpStatus(502)).toBe(true);
    expect(isTransientBullhornHttpStatus(503)).toBe(true);
    expect(isTransientBullhornHttpStatus(504)).toBe(true);
    expect(isTransientBullhornHttpStatus(401)).toBe(false);
    expect(isTransientBullhornHttpStatus(429)).toBe(false);
    expect(isTransientBullhornHttpStatus(500)).toBe(false);
    expect(isTransientBullhornHttpStatus(400)).toBe(false);
  });

  it("uses bounded exponential backoff", () => {
    expect(TRANSIENT_HTTP_MAX_RETRIES).toBe(3);
    expect(transientHttpBackoffMs(1)).toBe(500);
    expect(transientHttpBackoffMs(2)).toBe(1000);
    expect(transientHttpBackoffMs(3)).toBe(2000);
    expect(transientHttpBackoffMs(10)).toBe(4000);
  });
});
