import { describe, it, expect, vi, beforeEach } from "vitest";

// Drive the whole pipeline deterministically: a candidate whose STRUCTURED fields and
// RÉSUMÉ only mention a synonym ("Amazon Web Services") of the required concept ("AWS").
// Before the concept-threading fix this candidate was under-scored and — under
// requireResumeConfirmation — wrongly dropped. These tests lock in the end-to-end fix.
const mockState = vi.hoisted(() => ({
  pool: [] as Array<Record<string, unknown>>,
  resumeById: {} as Record<number, { matched: string[]; fail?: boolean }>,
}));

vi.mock("./bullhorn-client.js", () => ({
  searchCandidates: vi.fn(async () => mockState.pool),
  getCandidate: vi.fn(async (args: { id: number }) => ({
    data: mockState.pool.find((c) => c.id === args.id) ?? { id: args.id },
  })),
  getCandidateResume: vi.fn(async (args: { candidateId: number; highlight?: string[] }) => {
    const cfg = mockState.resumeById[args.candidateId];
    if (!cfg || cfg.fail) throw new Error("resume unavailable");
    return {
      matchedTerms: cfg.matched,
      excerpts: cfg.matched.map((t) => ({ term: t, text: `…${t} in résumé…` })),
    };
  }),
}));

const { findCandidates } = await import("./find-candidates.js");

type FindResult = {
  matches: Array<{
    candidateId: number;
    matchedSkills: string[];
    resumeConfirmed: string[];
  }>;
};

beforeEach(() => {
  mockState.pool = [];
  mockState.resumeById = {};
});

describe("findCandidates (synonym-aware end to end)", () => {
  it("scores and confirms a candidate whose evidence is ONLY a synonym of the required concept", async () => {
    mockState.pool = [{ id: 1, name: "Syn Only", status: "Active", skillSet: "Amazon Web Services" }];
    mockState.resumeById = { 1: { matched: ["Amazon Web Services"] } };

    const res = (await findCandidates({ mustHave: ["AWS"] })) as FindResult;
    const m = res.matches.find((x) => x.candidateId === 1);
    expect(m).toBeDefined();
    // Hit and confirmation are reported under the CANONICAL label, not the synonym.
    expect(m!.matchedSkills).toEqual(["AWS"]);
    expect(m!.resumeConfirmed).toEqual(["AWS"]);
  });

  it("RETAINS a synonym-only candidate under requireResumeConfirmation=true", async () => {
    mockState.pool = [
      { id: 1, name: "Syn Only", status: "Active", skillSet: "Amazon Web Services" },
      { id: 2, name: "No Eviden", status: "Active", skillSet: "Azure" },
    ];
    // #1 confirms via synonym only; #2 confirms nothing.
    mockState.resumeById = { 1: { matched: ["Amazon Web Services"] }, 2: { matched: [] } };

    const res = (await findCandidates({
      mustHave: ["AWS"],
      requireResumeConfirmation: true,
    })) as FindResult;
    const ids = res.matches.map((m) => m.candidateId);
    expect(ids).toContain(1); // survives the hard filter via synonym evidence
    expect(ids).not.toContain(2); // dropped: no concept confirmed anywhere
  });
});
