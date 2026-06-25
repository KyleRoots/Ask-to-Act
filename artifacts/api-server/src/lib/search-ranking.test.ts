import { describe, it, expect } from "vitest";
import { rankCandidates, scoreCandidate, structuredSkillHits, isLocalMatch } from "./search-ranking.js";

const NOW = Date.UTC(2026, 5, 25);
const DAY = 24 * 3600 * 1000;

function cand(
  id: number,
  opts: {
    skillSet?: string;
    occupation?: string;
    status?: string;
    city?: string;
    state?: string;
    modifiedDaysAgo?: number;
    availableInDays?: number;
  } = {},
) {
  return {
    id,
    skillSet: opts.skillSet ?? "",
    occupation: opts.occupation ?? "",
    status: opts.status ?? "New Lead",
    address: { city: opts.city ?? "", state: opts.state ?? "" },
    dateLastModified: opts.modifiedDaysAgo !== undefined ? NOW - opts.modifiedDaysAgo * DAY : undefined,
    dateAvailable: opts.availableInDays !== undefined ? NOW + opts.availableInDays * DAY : undefined,
  } as Record<string, unknown>;
}

describe("structuredSkillHits / isLocalMatch", () => {
  it("finds terms across skillSet and occupation, case-insensitively", () => {
    const c = cand(1, { skillSet: "Python, Selenium", occupation: "QA Engineer" });
    expect(structuredSkillHits(c, ["python", "qa engineer", "java"])).toEqual(["python", "qa engineer"]);
  });

  it("matches local by city or state", () => {
    const c = cand(1, { city: "Ottawa", state: "ON" });
    expect(isLocalMatch(c, "Ottawa", "QC")).toBe(true);
    expect(isLocalMatch(c, "Toronto", "ON")).toBe(true);
    expect(isLocalMatch(c, "Toronto", "BC")).toBe(false);
    expect(isLocalMatch(c, undefined, undefined)).toBe(false);
  });
});

describe("rankCandidates", () => {
  const ctx = { mustTerms: ["Python", "Selenium"], jobCity: "Ottawa", jobState: "ON", now: NOW };

  it("ranks more required-skill hits above fewer", () => {
    const pool = [
      cand(1, { skillSet: "Python" }),
      cand(2, { skillSet: "Python, Selenium" }),
    ];
    const ranked = rankCandidates(pool, ctx);
    expect(ranked[0].id).toBe(2);
  });

  it("breaks ties by local, then availability, then recency", () => {
    const remote = cand(1, { skillSet: "Python, Selenium", city: "Vancouver", state: "BC" });
    const local = cand(2, { skillSet: "Python, Selenium", city: "Ottawa", state: "ON" });
    const ranked = rankCandidates([remote, local], ctx);
    expect(ranked[0].id).toBe(2);
    expect(ranked[0].signals.isLocal).toBe(true);
  });

  it("rewards résumé-confirmed skills via verifiedTermsById", () => {
    const pool = [cand(1, { skillSet: "Python, Selenium" }), cand(2, { skillSet: "Python, Selenium" })];
    const verifiedTermsById = new Map<number, string[]>([[2, ["Selenium"]]]);
    const ranked = rankCandidates(pool, { ...ctx, jobCity: undefined, jobState: undefined, verifiedTermsById });
    expect(ranked[0].id).toBe(2);
    expect(ranked[0].signals.verifiedSkillHits).toEqual(["Selenium"]);
  });

  it("scores a synonym-only candidate as a required-skill hit via mustConcepts", () => {
    // mustConcepts treats "Amazon Web Services" as satisfying the "AWS" requirement,
    // so a candidate whose skillSet only says the synonym still scores the hit.
    const conceptCtx = {
      mustTerms: ["AWS"],
      mustConcepts: [{ canonical: "AWS", terms: ["AWS", "Amazon Web Services"] }],
      now: NOW,
    };
    const synonymOnly = cand(1, { skillSet: "Amazon Web Services" });
    const noHit = cand(2, { skillSet: "Azure" });
    const ranked = rankCandidates([noHit, synonymOnly], conceptCtx);
    expect(ranked[0].id).toBe(1);
    expect(ranked[0].signals.structuredSkillHits).toEqual(["AWS"]);
    expect(ranked[1].signals.structuredSkillHits).toEqual([]);
  });

  it("surfaces human-readable reasons", () => {
    const r = scoreCandidate(
      cand(1, { skillSet: "Python, Selenium", city: "Ottawa", state: "ON", modifiedDaysAgo: 5, availableInDays: 0 }),
      ctx,
      0,
    );
    expect(r.reasons.join(" | ")).toMatch(/skills on file/);
    expect(r.reasons.join(" | ")).toMatch(/local/);
    expect(r.reasons.join(" | ")).toMatch(/available/);
    expect(r.reasons.join(" | ")).toMatch(/last 30 days/);
  });
});
