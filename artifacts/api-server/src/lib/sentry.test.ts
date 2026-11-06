import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Breadcrumb, ErrorEvent } from "@sentry/node";
import { scrubSentryBreadcrumb, scrubSentryEvent } from "./sentry.js";

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

describe("sentry scrubbing", () => {
  it("drops the query string from an authorize breadcrumb", () => {
    const breadcrumb: Breadcrumb = {
      type: "http",
      category: "http",
      data: {
        url: "https://auth.example/oauth/authorize?username=x&password=secret&client_id=y",
        "http.query": "?username=x&password=secret&client_id=y",
        "http.method": "GET",
      },
    };

    const out = scrubSentryBreadcrumb(breadcrumb);

    expect(JSON.stringify(out)).not.toContain("secret");
    expect(out?.data?.url).toBe("https://auth.example/oauth/authorize");
    expect(out?.data?.["http.query"]).toBeUndefined();
    expect(out?.data?.["http.method"]).toBe("GET");
  });

  it("drops a token query that is only on http.query", () => {
    const breadcrumb: Breadcrumb = {
      type: "fetch",
      category: "fetch",
      data: {
        url: "https://auth.example/oauth/token",
        "http.query": "client_secret=secret&code=auth-code",
      },
    };

    const out = scrubSentryBreadcrumb(breadcrumb);

    expect(JSON.stringify(out)).not.toContain("secret");
    expect(JSON.stringify(out)).not.toContain("auth-code");
    expect(out?.data?.url).toBe("https://auth.example/oauth/token");
    expect(out?.data?.["http.query"]).toBeUndefined();
  });

  it("leaves an ordinary http breadcrumb unchanged", () => {
    const breadcrumb: Breadcrumb = {
      type: "http",
      category: "http",
      data: {
        url: "https://rest.example/ping?version=1",
        "http.query": "?version=1",
      },
    };

    expect(scrubSentryBreadcrumb(breadcrumb)).toBe(breadcrumb);
  });

  it("removes the body from a per-firm connect event", () => {
    const event: ErrorEvent = {
      type: undefined,
      message: "connect failed",
      request: {
        method: "POST",
        url: "https://connect.example/api/firms/abc/bullhorn-connect",
        headers: {
          authorization: "Bearer tok",
          cookie: "sid=1",
          accept: "application/json",
        },
        data: { username: "firm.api.user", password: "secret" },
        query_string: "password=secret",
      },
    };

    const out = scrubSentryEvent(event);

    expect(JSON.stringify(out)).not.toContain("secret");
    expect(out.request?.data).toBeUndefined();
    expect(out.request?.query_string).toBeUndefined();
    expect(out.request?.headers?.authorization).toBeUndefined();
    expect(out.request?.headers?.cookie).toBeUndefined();
    expect(out.request?.headers?.accept).toBe("application/json");
    expect(out.message).toBe("connect failed");
  });

  it("removes the body from a service Bullhorn auth event", () => {
    const event: ErrorEvent = {
      type: undefined,
      request: {
        method: "POST",
        url: "/api/auth/bullhorn/connect",
        data: { firmId: "abc", password: "secret" },
        query_string: { password: "secret" },
      },
    };

    const out = scrubSentryEvent(event);

    expect(JSON.stringify(out)).not.toContain("secret");
    expect(out.request?.data).toBeUndefined();
    expect(out.request?.query_string).toBeUndefined();
    expect(out.request?.url).toBe("/api/auth/bullhorn/connect");
  });

  it("redacts a password field on an unrelated request body", () => {
    const event: ErrorEvent = {
      type: undefined,
      request: {
        url: "/api/support/help",
        data: { subject: "help", meta: { password: "secret", ticket: "1" } },
      },
    };

    const out = scrubSentryEvent(event);

    expect(JSON.stringify(out)).not.toContain("secret");
    expect(out.request?.data).toEqual({ subject: "help", meta: { ticket: "1" } });
  });

  it("leaves an unrelated event unchanged", () => {
    const event: ErrorEvent = {
      type: undefined,
      message: "usage",
      request: {
        method: "GET",
        url: "/api/firms/abc/usage",
        headers: { accept: "application/json" },
        data: { name: "Acme" },
        query_string: "page=1",
      },
    };
    const before = structuredClone(event);

    expect(scrubSentryEvent(event)).toEqual(before);
  });
});
