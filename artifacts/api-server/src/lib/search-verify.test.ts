import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the résumé fetch so we can drive matched/missing/error paths deterministically.
const mockState = vi.hoisted(() => ({
  byId: {} as Record<
    number,
    { matched: string[]; fail?: boolean; excerptShape?: "legacy" | "real" }
  >,
}));

vi.mock("./bullhorn-client.js", () => ({
  getCandidateResume: vi.fn(async (args: { candidateId: number; highlight?: string[] }) => {
    const cfg = mockState.byId[args.candidateId];
    if (!cfg || cfg.fail) throw new Error("resume unavailable");
    if (cfg.excerptShape === "real") {
      return {
        matchedTerms: cfg.matched,
        excerpts: [{ terms: cfg.matched, quote: `…${cfg.matched.join(" / ")} in résumé…` }],
      };
    }
    return {
      matchedTerms: cfg.matched,
      excerpts: cfg.matched.map((t) => ({ term: t, text: `…${t} in résumé…` })),
    };
  }),
}));

const { verifyCandidates, confirmedIds, verifyConcepts, confirmedConceptIds } = await import(
  "./search-verify.js"
);

beforeEach(() => {
  mockState.byId = {};
});

describe("verifyCandidates", () => {
  it("splits requested terms into matched and missing per candidate", async () => {
    mockState.byId = { 1: { matched: ["Python"] }, 2: { matched: ["Python", "Selenium"] } };
    const r = await verifyCandidates([1, 2], ["Python", "Selenium"]);
    expect(r.get(1)).toMatchObject({ matchedTerms: ["Python"], missingTerms: ["Selenium"] });
    expect(r.get(2)).toMatchObject({ matchedTerms: ["Python", "Selenium"], missingTerms: [] });
  });

  it("treats a résumé fetch failure as nothing-confirmed (fails closed for the claim)", async () => {
    mockState.byId = { 1: { matched: [], fail: true } };
    const r = await verifyCandidates([1], ["Python"]);
    expect(r.get(1)).toMatchObject({ matchedTerms: [], missingTerms: ["Python"] });
  });

  it("returns empty results without calling the résumé API when no terms are given", async () => {
    const r = await verifyCandidates([1, 2], []);
    expect(r.get(1)).toEqual({ matchedTerms: [], missingTerms: [], excerpts: [] });
  });

  it("caps excerpts to keep the payload lean", async () => {
    mockState.byId = { 1: { matched: ["a", "b", "c", "d", "e"] } };
    const r = await verifyCandidates([1], ["a", "b", "c", "d", "e"]);
    expect(r.get(1)!.excerpts.length).toBeLessThanOrEqual(3);
  });
});

describe("confirmedIds", () => {
  it("keeps only candidates whose résumé confirmed a required term", async () => {
    mockState.byId = { 1: { matched: ["Python"] }, 2: { matched: [] } };
    const v = await verifyCandidates([1, 2], ["Python"]);
    const keep = confirmedIds(v, ["Python"]);
    expect(keep.has(1)).toBe(true);
    expect(keep.has(2)).toBe(false);
  });
});

describe("verifyConcepts (synonym-aware résumé confirmation)", () => {
  const aws = { canonical: "AWS", terms: ["AWS", "Amazon Web Services"] };
  const ts = { canonical: "TypeScript", terms: ["TypeScript", "TS"] };

  it("confirms a concept when the résumé only mentions a SYNONYM, not the canonical term", async () => {
    // Candidate's résumé says "Amazon Web Services" though the query asked for "AWS".
    mockState.byId = { 1: { matched: ["Amazon Web Services"] } };
    const r = await verifyConcepts([1], [aws]);
    expect(r.get(1)).toMatchObject({
      matchedConcepts: ["AWS"],
      missingConcepts: [],
      matchedTerms: ["Amazon Web Services"],
    });
  });

  it("maps multiple synonym hits back to their canonical labels", async () => {
    mockState.byId = { 1: { matched: ["Amazon Web Services", "TS"] } };
    const r = await verifyConcepts([1], [aws, ts]);
    expect(r.get(1)!.matchedConcepts.sort()).toEqual(["AWS", "TypeScript"]);
    expect(r.get(1)!.missingConcepts).toEqual([]);
  });

  it("reports a concept missing when NONE of its synonyms appear", async () => {
    mockState.byId = { 1: { matched: ["Amazon Web Services"] } };
    const r = await verifyConcepts([1], [aws, ts]);
    expect(r.get(1)).toMatchObject({ matchedConcepts: ["AWS"], missingConcepts: ["TypeScript"] });
  });

  it("fails closed (concept missing) when the résumé fetch throws", async () => {
    mockState.byId = { 1: { matched: [], fail: true } };
    const r = await verifyConcepts([1], [aws]);
    expect(r.get(1)).toMatchObject({ matchedConcepts: [], missingConcepts: ["AWS"] });
  });

  it("returns empty results without calling the résumé API when no concepts are given", async () => {
    const r = await verifyConcepts([1, 2], []);
    expect(r.get(1)).toEqual({
      matchedConcepts: [],
      missingConcepts: [],
      matchedTerms: [],
      excerpts: [],
      probeExcerpts: [],
    });
  });

  it("keeps probe hits out of skill evidence and out of matchedTerms", async () => {
    mockState.byId = { 1: { matched: ["AWS", "years of experience"] } };
    const r = await verifyConcepts([1], [aws], { probeTerms: ["years of experience"] });
    const res = r.get(1)!;
    expect(res.matchedConcepts).toEqual(["AWS"]);
    // An experience phrase must never be citable as proof of a skill.
    expect(res.matchedTerms).toEqual(["AWS"]);
    expect(res.excerpts.every((e) => !e.terms.includes("years of experience"))).toBe(true);
    expect(res.probeExcerpts.some((e) => e.terms.includes("years of experience"))).toBe(true);
  });

  it("cannot satisfy a concept using only a probe term", async () => {
    mockState.byId = { 1: { matched: ["years of experience"] } };
    const r = await verifyConcepts([1], [aws], { probeTerms: ["years of experience"] });
    expect(r.get(1)!.missingConcepts).toEqual(["AWS"]);
  });

  it("still fetches résumés for probes when there are no skill concepts", async () => {
    mockState.byId = { 1: { matched: ["years of experience"] } };
    const r = await verifyConcepts([1], [], { probeTerms: ["years of experience"] });
    expect(r.get(1)!.probeExcerpts).toHaveLength(1);
  });

  it("strips probe terms from overlapping skill quotes (real excerpt shape)", async () => {
    // getCandidateResume merges nearby windows into one quote with a terms[].
    mockState.byId = {
      1: {
        matched: ["Software", "years of experience"],
        excerptShape: "real",
      },
    };
    const r = await verifyConcepts([1], [{ canonical: "Software", terms: ["Software"] }], {
      probeTerms: ["years of experience"],
    });
    const res = r.get(1)!;
    expect(res.excerpts[0]?.terms).toEqual(["Software"]);
    expect(res.probeExcerpts[0]?.terms).toEqual(["years of experience"]);
  });
});

describe("confirmedConceptIds (synonym-aware hard filter)", () => {
  const aws = { canonical: "AWS", terms: ["AWS", "Amazon Web Services"] };

  it("keeps a candidate confirmed only via a synonym, drops one with no concept hit", async () => {
    mockState.byId = { 1: { matched: ["Amazon Web Services"] }, 2: { matched: [] } };
    const v = await verifyConcepts([1, 2], [aws]);
    const keep = confirmedConceptIds(v);
    expect(keep.has(1)).toBe(true);
    expect(keep.has(2)).toBe(false);
  });
});
