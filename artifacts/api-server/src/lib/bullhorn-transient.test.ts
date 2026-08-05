import { describe, it, expect } from "vitest";
import {
  isTransientBullhornHttpStatus,
  isTransientBullhornErrorBody,
  isTransientBullhornResponse,
  transientHttpBackoffMs,
  TRANSIENT_HTTP_MAX_RETRIES,
} from "./bullhorn-transient.js";

/** Verbatim body seen on the 2026-08-05 MYT-Ottawa note-snapshot failure. */
const HTTP_INVOKER_500 =
  "Could not access HTTP invoker remote service at " +
  "[http://localhost:8083/data-services-4.0/sr/SelectBuilder]; nested exception is " +
  "org.apache.http.NoHttpResponseException: localhost:8083 failed to respond";

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

  it("treats a 500 naming an upstream transport failure as transient", () => {
    expect(isTransientBullhornErrorBody(HTTP_INVOKER_500)).toBe(true);
    expect(isTransientBullhornResponse(500, HTTP_INVOKER_500)).toBe(true);
    for (const body of [
      "java.net.ConnectException: Connection refused",
      "java.net.SocketTimeoutException: Read timed out",
      "nested exception is java.net.SocketException: Connection reset",
    ]) {
      expect(isTransientBullhornResponse(500, body)).toBe(true);
    }
  });

  it("does not retry genuine 500s or 4xx regardless of body", () => {
    expect(
      isTransientBullhornResponse(500, '{"errorMessage":"badSearchQuery"}'),
    ).toBe(false);
    expect(isTransientBullhornResponse(500, "")).toBe(false);
    expect(isTransientBullhornResponse(500, undefined)).toBe(false);
    expect(isTransientBullhornResponse(400, HTTP_INVOKER_500)).toBe(false);
    expect(isTransientBullhornResponse(401, HTTP_INVOKER_500)).toBe(false);
    expect(isTransientBullhornResponse(429, HTTP_INVOKER_500)).toBe(false);
    expect(isTransientBullhornErrorBody(null)).toBe(false);
  });

  it("keeps retrying gateway statuses without a body", () => {
    expect(isTransientBullhornResponse(502)).toBe(true);
    expect(isTransientBullhornResponse(503, "")).toBe(true);
    expect(isTransientBullhornResponse(504, "anything")).toBe(true);
  });

  it("uses bounded exponential backoff", () => {
    expect(TRANSIENT_HTTP_MAX_RETRIES).toBe(3);
    expect(transientHttpBackoffMs(1)).toBe(500);
    expect(transientHttpBackoffMs(2)).toBe(1000);
    expect(transientHttpBackoffMs(3)).toBe(2000);
    expect(transientHttpBackoffMs(10)).toBe(4000);
  });
});
