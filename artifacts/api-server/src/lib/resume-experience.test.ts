import { describe, it, expect } from "vitest";

import { parseResumeYears, reconcileExperience } from "./resume-experience.js";

const excerpt = (text: string) => [{ term: "years of experience", text }];

describe("parseResumeYears", () => {
  it("reads an explicit total from résumé prose", () => {
    // Shape taken from a real Myticas résumé (candidate 3691261).
    const r = parseResumeYears(excerpt("Total years experience: 30 Years, 10 Months"));
    expect(r?.years).toBe(30);
    expect(r?.evidence).toContain("30 Years");
  });

  it("handles a '+' qualifier", () => {
    expect(parseResumeYears(excerpt("Over 8 + years of professional experience"))?.years).toBe(8);
  });

  it("handles spelled-out numbers", () => {
    expect(parseResumeYears(excerpt("seven years professional experience"))?.years).toBe(7);
  });

  it("takes the largest plausible claim when several are listed", () => {
    const r = parseResumeYears(
      excerpt("9 years of HTML 9 years of CSS 2 years of SCSS 14+ years of core IT experience"),
    );
    expect(r?.years).toBe(14);
  });

  it("rejects implausible values that are really dates", () => {
    expect(parseResumeYears(excerpt("2015 years"))).toBeNull();
  });

  it("returns null when the résumé never states years", () => {
    expect(parseResumeYears(excerpt("Skilled Database Analyst"))).toBeNull();
    expect(parseResumeYears([])).toBeNull();
    expect(parseResumeYears(undefined)).toBeNull();
  });
});

describe("reconcileExperience", () => {
  it("reports nothing derivable when both sources are empty", () => {
    expect(reconcileExperience(null, null)).toMatchObject({ years: null, agreement: "none" });
  });

  it("uses work history alone when the résumé is silent", () => {
    expect(reconcileExperience(null, 12)).toMatchObject({ years: 12, agreement: "history_only" });
  });

  it("uses the résumé alone when work history is unparsed", () => {
    // Real case: candidate 3838099 had no usable workHistories at all.
    expect(reconcileExperience(15, null)).toMatchObject({ years: 15, agreement: "resume_only" });
  });

  it("treats close estimates as agreement and keeps the higher figure", () => {
    expect(reconcileExperience(30, 28)).toMatchObject({ years: 30, agreement: "agree" });
  });

  it("flags a conflict when Bullhorn's parse wildly understates the résumé", () => {
    // Real case: candidate 3785042 came back as 0.9 years from workHistories.
    const r = reconcileExperience(12, 0.9);
    expect(r.agreement).toBe("conflict");
    expect(r.resumeYears).toBe(12);
    expect(r.historyYears).toBe(0.9);
  });

  it("does not call small absolute gaps a conflict", () => {
    expect(reconcileExperience(4, 2).agreement).toBe("agree");
  });
});
