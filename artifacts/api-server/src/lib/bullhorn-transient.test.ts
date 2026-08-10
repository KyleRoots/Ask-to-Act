import { describe, it, expect } from "vitest";
import {
  describeFetchError,
  fetchWithTransientRetry,
  isTransientBullhornHttpStatus,
  isTransientBullhornErrorBody,
  isTransientBullhornResponse,
  isTransientFetchError,
  transientHttpBackoffMs,
  TRANSIENT_HTTP_MAX_RETRIES,
} from "./bullhorn-transient.js";

/** Shape undici produces: `TypeError: fetch failed` carrying the reason on `cause`. */
function undiciFetchFailure(code: string, message: string): Error {
  const cause = Object.assign(new Error(message), { code });
  return new TypeError("fetch failed", { cause });
}

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

  it("treats a rejected fetch as transient via cause code or message", () => {
    for (const code of [
      "ECONNRESET",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENOTFOUND",
      "UND_ERR_SOCKET",
      "UND_ERR_CONNECT_TIMEOUT",
    ]) {
      expect(
        isTransientFetchError(undiciFetchFailure(code, "read error")),
      ).toBe(true);
    }
    // The 2026-08-10 note-snapshot failures surfaced with the cause already lost.
    expect(isTransientFetchError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientFetchError(new Error("socket hang up"))).toBe(true);
    expect(isTransientFetchError(new TypeError("terminated"))).toBe(true);
  });

  it("does not retry deliberate aborts or application errors", () => {
    const abort = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    expect(isTransientFetchError(abort)).toBe(false);
    expect(
      isTransientFetchError(new TypeError("fetch failed", { cause: abort })),
    ).toBe(false);
    expect(isTransientFetchError(new Error('Invalid field "foo"'))).toBe(false);
    expect(isTransientFetchError(new TypeError("Failed to parse URL"))).toBe(
      false,
    );
    expect(isTransientFetchError(undefined)).toBe(false);
    expect(isTransientFetchError("ECONNRESET")).toBe(false);
  });

  it("describes a rejected fetch with its underlying cause", () => {
    expect(
      describeFetchError(undiciFetchFailure("ECONNRESET", "read ECONNRESET")),
    ).toBe("fetch failed (ECONNRESET: read ECONNRESET)");
    expect(describeFetchError(new TypeError("fetch failed"))).toBe(
      "fetch failed",
    );
    expect(describeFetchError(null)).toBe("unknown fetch failure");
  });

  it("describes a self-referencing cause chain without looping", () => {
    const err = new Error("fetch failed") as Error & { cause?: unknown };
    err.cause = err;
    expect(describeFetchError(err)).toBe("fetch failed");
    expect(isTransientFetchError(err)).toBe(true);
  });

  it("retries a transient network failure and returns the eventual response", async () => {
    const ok = new Response("{}", { status: 200 });
    let calls = 0;
    const delays: number[] = [];
    const res = await fetchWithTransientRetry(
      () => {
        calls += 1;
        if (calls < 3) {
          return Promise.reject(
            undiciFetchFailure("ECONNRESET", "read ECONNRESET"),
          );
        }
        return Promise.resolve(ok);
      },
      { sleep: async (ms) => void delays.push(ms) },
    );
    expect(res).toBe(ok);
    expect(calls).toBe(3);
    expect(delays).toEqual([500, 1000]);
  });

  it("gives up after a bounded number of retries and names the cause", async () => {
    let calls = 0;
    const delays: number[] = [];
    await expect(
      fetchWithTransientRetry(
        () => {
          calls += 1;
          return Promise.reject(undiciFetchFailure("EAI_AGAIN", "getaddrinfo"));
        },
        { sleep: async (ms) => void delays.push(ms) },
      ),
    ).rejects.toThrow(
      "Bullhorn request failed before a response: fetch failed (EAI_AGAIN: getaddrinfo)",
    );
    expect(calls).toBe(TRANSIENT_HTTP_MAX_RETRIES + 1);
    expect(delays).toEqual([500, 1000, 2000]);
  });

  it("does not retry a non-transient rejection", async () => {
    let calls = 0;
    await expect(
      fetchWithTransientRetry(() => {
        calls += 1;
        return Promise.reject(new TypeError("Failed to parse URL"));
      }),
    ).rejects.toThrow("Failed to parse URL");
    expect(calls).toBe(1);
  });

  it("preserves the original rejection as the error cause", async () => {
    const original = undiciFetchFailure("ECONNRESET", "read ECONNRESET");
    const err = await fetchWithTransientRetry(() => Promise.reject(original), {
      sleep: async () => {},
    }).catch((e: unknown) => e);
    expect((err as Error).cause).toBe(original);
  });

  it("passes a successful response through without retrying", async () => {
    const ok = new Response("{}", { status: 502 });
    let calls = 0;
    const res = await fetchWithTransientRetry(() => {
      calls += 1;
      return Promise.resolve(ok);
    });
    // Status-based retries stay with the caller; this loop only owns rejections.
    expect(res).toBe(ok);
    expect(calls).toBe(1);
  });

  it("uses bounded exponential backoff", () => {
    expect(TRANSIENT_HTTP_MAX_RETRIES).toBe(3);
    expect(transientHttpBackoffMs(1)).toBe(500);
    expect(transientHttpBackoffMs(2)).toBe(1000);
    expect(transientHttpBackoffMs(3)).toBe(2000);
    expect(transientHttpBackoffMs(10)).toBe(4000);
  });
});
