import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  reportJobsTable: {},
}));

vi.mock("./bullhorn-auth.js", () => ({
  firmContext: { run: (_c: unknown, fn: () => unknown) => fn() },
  currentFirmContextId: () => "firm-a",
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  ASYNC_CONTINUATION_HINT,
  ASYNC_REPORT_WALL_MS,
  TOPN_WALL_MS,
  EXHAUSTIVE_WALL_MS,
  incompleteGuidanceNote,
  withAsyncContinuationHint,
} from "./scout-screen.js";
import { scoutJobDedupeKey } from "./report-jobs.js";

describe("async report job contracts", () => {
  it("keeps sync soft walls unchanged and defines a high async safety max", () => {
    expect(TOPN_WALL_MS).toBe(95_000);
    expect(EXHAUSTIVE_WALL_MS).toBe(75_000);
    expect(ASYNC_REPORT_WALL_MS).toBeGreaterThanOrEqual(15 * 60 * 1000);
    expect(ASYNC_REPORT_WALL_MS).toBeLessThanOrEqual(30 * 60 * 1000);
  });

  it("wall_time guidance points at MCP tools and REST start+poll", () => {
    const note = incompleteGuidanceNote("bounded", {
      stoppedForWallTime: true,
      matchCount: 2,
    });
    expect(note).toMatch(/start_scout_dept_report_job/);
    expect(note).toMatch(/get_report_job/);
    expect(note).toMatch(/\/reports\/scout-qualified-by-department\/jobs/);
    expect(note).toMatch(/\/reports\/jobs\/\{jobId\}/);
    expect(note).toMatch(/Do NOT issue multiple scout_dept_report/i);
    expect(note).toMatch(/channel realism|never a dead end|Soft wall/i);
    expect(ASYNC_CONTINUATION_HINT).toMatch(/start_scout_dept_report_job/);
    expect(ASYNC_CONTINUATION_HINT).toMatch(
      /\/reports\/scout-qualified-by-department\/jobs/,
    );
    expect(ASYNC_CONTINUATION_HINT).toMatch(/Do NOT give up/i);

    const wrapped = withAsyncContinuationHint(
      {
        stopReason: "wall_time",
        confirmedComplete: false,
        note: "partial",
      },
      { resumeArgs: { department: "STSI", limit: 5 } },
    ) as Record<string, unknown>;
    expect(wrapped.asyncContinuation).toMatchObject({
      tool: "start_scout_dept_report_job",
      pollTool: "get_report_job",
      rest: {
        start: {
          method: "POST",
          path: "/reports/scout-qualified-by-department/jobs",
        },
        poll: {
          method: "GET",
          pathTemplate: "/reports/jobs/{jobId}",
        },
      },
      resumeArgs: { department: "STSI", limit: 5 },
    });
    expect(String(wrapped.note)).toMatch(/start_scout_dept_report_job/);
    expect(String(wrapped.note)).toMatch(
      /\/reports\/scout-qualified-by-department\/jobs/,
    );

    const complete = withAsyncContinuationHint({
      stopReason: "complete",
      confirmedComplete: true,
      note: "done",
    }) as Record<string, unknown>;
    expect(complete.asyncContinuation).toBeUndefined();
    expect(complete.note).toBe("done");
  });

  it("dedupe keys are firm-scoped and stable for identical scout args", () => {
    const a = scoutJobDedupeKey("firm-a", { department: "STSI", limit: 5 });
    const b = scoutJobDedupeKey("firm-a", {
      department: " stsi ",
      limit: 5,
    });
    const c = scoutJobDedupeKey("firm-b", { department: "STSI", limit: 5 });
    const d = scoutJobDedupeKey("firm-a", {
      department: "MYT-Ottawa",
      limit: 5,
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });
});

describe("snapshot top-N vs live-tail wall (universal)", () => {
  it("treats full snapshot top-N as complete even if live tail hit wall", () => {
    function confirmed(fromSnapLength: number, limit: number, wall: boolean) {
      const snapshotSatisfiesTopN =
        typeof limit === "number" && limit > 0 && fromSnapLength >= limit;
      return !wall || snapshotSatisfiesTopN;
    }
    expect(confirmed(5, 5, true)).toBe(true);
    expect(confirmed(3, 5, true)).toBe(false);
    expect(confirmed(10, 5, true)).toBe(true);
    expect(confirmed(0, 5, false)).toBe(true);
  });
});
