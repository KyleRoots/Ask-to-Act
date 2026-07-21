import { describe, it, expect } from "vitest";
import {
  buildDepartmentJobsQuery,
  planExhaustiveDateWindows,
  incompleteGuidanceNote,
} from "./scout-screen.js";

describe("buildDepartmentJobsQuery", () => {
  it("builds open-jobs query for any department string", () => {
    expect(buildDepartmentJobsQuery("STS-STSI", true)).toBe(
      'correlatedCustomText1:"STS-STSI" AND isOpen:true AND NOT status:Archive AND isDeleted:false',
    );
    expect(buildDepartmentJobsQuery("MYT-Ottawa", true)).toBe(
      'correlatedCustomText1:"MYT-Ottawa" AND isOpen:true AND NOT status:Archive AND isDeleted:false',
    );
  });

  it("escapes quotes inside department names", () => {
    expect(buildDepartmentJobsQuery('MYT-"Special"', true)).toContain(
      'correlatedCustomText1:"MYT-\\"Special\\""',
    );
  });

  it("omits open-jobs lock when openJobsOnly is false", () => {
    expect(buildDepartmentJobsQuery("STS-STSI", false)).toBe(
      'correlatedCustomText1:"STS-STSI" AND isDeleted:false',
    );
  });

  it("rejects blank department", () => {
    expect(() => buildDepartmentJobsQuery("  ", true)).toThrow(/department/);
  });
});

describe("planExhaustiveDateWindows", () => {
  it("splits a range into non-overlapping windows", () => {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const end = Date.parse("2026-01-29T00:00:00.000Z");
    const week = 7 * 24 * 60 * 60 * 1000;
    const windows = planExhaustiveDateWindows(start, end, week, 16);
    expect(windows.length).toBe(4);
    expect(windows[0]!.startMs).toBe(start);
    expect(windows[0]!.endMs).toBe(start + week);
    expect(windows.at(-1)!.endMs).toBe(end);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]!.startMs).toBe(windows[i - 1]!.endMs);
    }
  });

  it("stretches windows so maxWindows is never exceeded", () => {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const end = Date.parse("2026-07-01T00:00:00.000Z");
    const day = 24 * 60 * 60 * 1000;
    const windows = planExhaustiveDateWindows(start, end, day, 8);
    expect(windows.length).toBeLessThanOrEqual(8);
    expect(windows[0]!.startMs).toBe(start);
    expect(windows.at(-1)!.endMs).toBe(end);
  });

  it("rejects inverted ranges", () => {
    expect(() => planExhaustiveDateWindows(10, 10)).toThrow(/end after start/);
  });
});

describe("incompleteGuidanceNote", () => {
  it("forbids client-side date-window fan-out", () => {
    const bounded = incompleteGuidanceNote("bounded");
    expect(bounded).toMatch(/LOWER BOUND/i);
    expect(bounded).toMatch(/Do NOT issue multiple scout_dept_report/i);
    expect(bounded).toMatch(/mode=exhaustive/);

    const exhaustive = incompleteGuidanceNote("exhaustive");
    expect(exhaustive).toMatch(/LOWER BOUND/i);
    expect(exhaustive).toMatch(/Do NOT issue multiple scout_dept_report/i);
  });
});
