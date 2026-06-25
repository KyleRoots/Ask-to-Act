import { describe, it, expect } from "vitest";
import { deriveExperience } from "./candidate-experience.js";

const NOW = Date.UTC(2026, 5, 25); // 2026-06-25
const YEAR = 365.25 * 24 * 3600 * 1000;

function yearsAgo(n: number): number {
  return NOW - n * YEAR;
}

describe("deriveExperience", () => {
  it("sums tenure across sequential roles", () => {
    const cand = {
      workHistories: [
        { title: "Dev", companyName: "A", startDate: yearsAgo(8), endDate: yearsAgo(5) },
        { title: "Sr Dev", companyName: "B", startDate: yearsAgo(5), endDate: yearsAgo(1) },
      ],
    };
    const r = deriveExperience(cand, NOW);
    expect(r.yearsExperience).toBeCloseTo(7, 0);
    expect(r.seniority).toBe("senior");
    expect(r.roleCount).toBe(2);
  });

  it("does not double-count overlapping (concurrent) roles", () => {
    const cand = {
      workHistories: [
        { title: "Dev", companyName: "A", startDate: yearsAgo(6), endDate: yearsAgo(2) },
        { title: "Contractor", companyName: "B", startDate: yearsAgo(5), endDate: yearsAgo(3) },
      ],
    };
    const r = deriveExperience(cand, NOW);
    // Union of [6y..2y] and [5y..3y] is just [6y..2y] = 4 years, not 6.
    expect(r.yearsExperience).toBeCloseTo(4, 0);
  });

  it("treats a missing end date as a current role with zero recency gap", () => {
    const cand = {
      workHistories: [{ title: "Lead", companyName: "C", startDate: yearsAgo(3), endDate: 0 }],
    };
    const r = deriveExperience(cand, NOW);
    expect(r.currentRole).toEqual({ title: "Lead", company: "C" });
    expect(r.lastActivityMonthsAgo).toBe(0);
    expect(r.yearsExperience).toBeCloseTo(3, 0);
  });

  it("computes months-since-last-role when not currently employed", () => {
    const cand = {
      workHistories: [{ title: "Dev", companyName: "A", startDate: yearsAgo(4), endDate: yearsAgo(1) }],
    };
    const r = deriveExperience(cand, NOW);
    expect(r.currentRole).toBeNull();
    expect(r.lastActivityMonthsAgo).toBeGreaterThanOrEqual(11);
    expect(r.lastActivityMonthsAgo).toBeLessThanOrEqual(13);
  });

  it("returns nulls for a candidate with no dated work history", () => {
    expect(deriveExperience({ workHistories: [] }, NOW).yearsExperience).toBeNull();
    expect(deriveExperience({}, NOW).seniority).toBe("unknown");
  });

  it("bands seniority by years", () => {
    const mk = (yrs: number) => ({
      workHistories: [{ startDate: yearsAgo(yrs), endDate: 0 }],
    });
    expect(deriveExperience(mk(1), NOW).seniority).toBe("junior");
    expect(deriveExperience(mk(4), NOW).seniority).toBe("mid");
    expect(deriveExperience(mk(8), NOW).seniority).toBe("senior");
    expect(deriveExperience(mk(12), NOW).seniority).toBe("lead");
  });
});
