import { describe, it, expect } from "vitest";
import { toConcepts } from "./search-taxonomy.js";
import {
  assessRelevantRecency,
  overlayWorkHistory,
  relevantRecencyPoints,
  roleTextHitsConcepts,
} from "./relevant-recency.js";

const NOW = Date.UTC(2026, 7, 18);
const YEAR = 365.25 * 24 * 3600 * 1000;
const security = toConcepts(["security testing", "threat modeling"]);

function yearsAgo(n: number): number {
  return NOW - n * YEAR;
}

describe("roleTextHitsConcepts", () => {
  it("hits a product-security title from security-testing concepts via distinctive tokens", () => {
    expect(roleTextHitsConcepts("Staff Product Security Engineer", security)).toEqual(
      expect.arrayContaining(["security testing"]),
    );
  });

  it("does not treat generic seniority titles as relevant", () => {
    expect(roleTextHitsConcepts("Senior Staff Engineer", security)).toEqual([]);
  });
});

describe("assessRelevantRecency", () => {
  it("treats a current matching title as current", () => {
    const r = assessRelevantRecency(
      {
        occupation: "",
        workHistories: [
          {
            title: "Staff Product Security Engineer",
            companyName: "Jane Software",
            startDate: yearsAgo(1),
            endDate: 0,
          },
        ],
      },
      security,
      NOW,
    );
    expect(r.band).toBe("current");
    expect(r.source).toBe("current_role");
    expect(relevantRecencyPoints(r.band)).toBe(10);
  });

  it("bands a matching role that ended 4 years ago as recent_7y, not current", () => {
    const r = assessRelevantRecency(
      {
        workHistories: [
          {
            title: "Threat Researcher",
            startDate: yearsAgo(6),
            endDate: yearsAgo(4),
          },
        ],
      },
      security,
      NOW,
    );
    expect(r.band).toBe("recent_7y");
    expect(relevantRecencyPoints(r.band)).toBe(3);
  });

  it("does not penalize missing dates — occupation stands in as current", () => {
    const r = assessRelevantRecency(
      { occupation: "Information Security Specialist and Threat Researcher" },
      security,
      NOW,
    );
    expect(r.band).toBe("current");
    expect(r.source).toBe("occupation");
  });

  it("does not let a stale occupation outrank a current unrelated title", () => {
    const r = assessRelevantRecency(
      {
        occupation: "Information Security Specialist",
        workHistories: [
          { title: "Barista", companyName: "Cafe", startDate: yearsAgo(1), endDate: 0 },
          {
            title: "Threat Researcher",
            companyName: "Trend Micro",
            startDate: yearsAgo(10),
            endDate: yearsAgo(8),
          },
        ],
      },
      security,
      NOW,
    );
    expect(r.band).toBe("older");
    expect(r.source).toBe("recent_role");
  });

  it("returns unknown (zero points) when nothing dated or occupational matches", () => {
    const r = assessRelevantRecency(
      { occupation: "Account Executive", workHistories: [] },
      security,
      NOW,
    );
    expect(r.band).toBe("unknown");
    expect(relevantRecencyPoints(r.band)).toBe(0);
  });
});

describe("overlayWorkHistory", () => {
  it("keeps search occupation when the entity fetch leaves it blank", () => {
    const merged = overlayWorkHistory(
      { id: 1, occupation: "Python Developer", skillSet: "Python" },
      { id: 1, occupation: "", workHistories: { data: [] } },
    );
    expect(merged.occupation).toBe("Python Developer");
  });
});
