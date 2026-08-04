import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
  opsAlertStateTable: {},
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  OPS_AGENT_DETAILS_MAX,
  OPS_AGENT_SUMMARY_MAX,
  opsAgentNotifyBodySchema,
  opsAgentNotifyFingerprint,
  opsAgentStartedDedupeMs,
  parseOpsAgentNotifyBody,
} from "./ops-agent-notify.js";

describe("parseOpsAgentNotifyBody", () => {
  it("accepts started with summary", () => {
    const result = parseOpsAgentNotifyBody({
      phase: "started",
      summary: "Investigating stale note-snapshot for Acme",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phase).toBe("started");
      expect(result.data.summary).toContain("note-snapshot");
    }
  });

  it("accepts completed and failed with optional details/fingerprint", () => {
    for (const phase of ["completed", "failed"] as const) {
      const result = parseOpsAgentNotifyBody({
        phase,
        summary: "Fixed lease reclaim",
        details: "Deployed + verified ops-health ok",
        fingerprint: "note-stale-acme",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.phase).toBe(phase);
        expect(result.data.details).toContain("Deployed");
        expect(result.data.fingerprint).toBe("note-stale-acme");
      }
    }
  });

  it("rejects missing summary", () => {
    const result = parseOpsAgentNotifyBody({ phase: "started" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/summary/i);
    }
  });

  it("rejects empty summary", () => {
    const result = parseOpsAgentNotifyBody({
      phase: "started",
      summary: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid phase", () => {
    const result = parseOpsAgentNotifyBody({
      phase: "running",
      summary: "hello",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/phase/i);
    }
  });

  it("rejects oversized summary", () => {
    const result = parseOpsAgentNotifyBody({
      phase: "started",
      summary: "x".repeat(OPS_AGENT_SUMMARY_MAX + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/summary/i);
    }
  });

  it("rejects oversized details", () => {
    const result = parseOpsAgentNotifyBody({
      phase: "completed",
      summary: "done",
      details: "y".repeat(OPS_AGENT_DETAILS_MAX + 1),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toMatch(/details/i);
    }
  });

  it("trims summary and details", () => {
    const parsed = opsAgentNotifyBodySchema.parse({
      phase: "completed",
      summary: "  fixed  ",
      details: "  ok  ",
    });
    expect(parsed.summary).toBe("fixed");
    expect(parsed.details).toBe("ok");
  });
});

describe("opsAgentNotifyFingerprint", () => {
  it("uses client fingerprint when provided", () => {
    expect(
      opsAgentNotifyFingerprint({
        phase: "started",
        summary: "anything",
        fingerprint: "job-stuck-abc",
      }),
    ).toBe("agent:started:job-stuck-abc");
  });

  it("hashes summary when fingerprint omitted", () => {
    const a = opsAgentNotifyFingerprint({
      phase: "started",
      summary: "Same Issue",
    });
    const b = opsAgentNotifyFingerprint({
      phase: "started",
      summary: "same issue",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^agent:started:[a-f0-9]{16}$/);
  });

  it("differs by phase", () => {
    const started = opsAgentNotifyFingerprint({
      phase: "started",
      summary: "same",
      fingerprint: "x",
    });
    const completed = opsAgentNotifyFingerprint({
      phase: "completed",
      summary: "same",
      fingerprint: "x",
    });
    expect(started).not.toBe(completed);
  });
});

describe("opsAgentStartedDedupeMs", () => {
  it("defaults to 15 minutes", () => {
    expect(opsAgentStartedDedupeMs({})).toBe(15 * 60 * 1000);
  });

  it("reads OPS_AGENT_NOTIFY_DEDUPE_MINUTES", () => {
    expect(
      opsAgentStartedDedupeMs({ OPS_AGENT_NOTIFY_DEDUPE_MINUTES: "5" }),
    ).toBe(5 * 60 * 1000);
  });
});
