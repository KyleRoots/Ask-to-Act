import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

const { searchCandidates, getCandidate, getCandidateResume } = await import("./bullhorn-client.js");

describe("findCandidates explicit search contract", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 16));
  });

  it("applies inclusive start and exclusive end at UTC midnight before ranking and verification", async () => {
    const start = Date.parse("2026-03-08T00:00:00Z");
    const end = Date.parse("2026-03-09T00:00:00Z");
    mockState.pool = [start - 1, start, end - 1, end].map((dateAdded, i) => ({ id: i + 1, dateAdded, skillSet: "AWS" }));
    mockState.pool.push({ id: 5, skillSet: "AWS" });
    const result = await findCandidates({ mustHave: ["AWS"], dateAddedStart: "2026-03-08", dateAddedEnd: "2026-03-09" }) as any;
    expect(result.matches.map((m: any) => m.candidateId).sort()).toEqual([2, 3]);
    expect(vi.mocked(searchCandidates).mock.calls[0][0].query).toBe("NOT status:Archive");
    expect(vi.mocked(getCandidate).mock.calls.map(([arg]) => arg.id).sort()).toEqual([2, 3]);
    expect(vi.mocked(getCandidateResume).mock.calls.map(([arg]) => arg.candidateId).sort()).toEqual([2, 3]);
    expect(result.appliedFilters.dateAdded).toEqual({ field: "Candidate.dateAdded", startInclusive: "2026-03-08", endExclusive: "2026-03-09", timezone: "UTC" });
    expect(result.totals.droppedRequestedFilters).toBe(3);
  });

  it.each([
    { dateAddedStart: "2026-02-30" },
    { dateAddedEnd: "2025-02-29" },
    { dateAddedStart: "2026-03-08T00:00:00-05:00" },
    { dateAddedStart: "03/08/2026" },
    { dateAddedStart: "2026-03-08", dateAddedEnd: "2026-03-08" },
    { dateAddedStart: "2026-03-09", dateAddedEnd: "2026-03-08" },
    { excludedStatuses: ["   "] },
  ])("rejects invalid filters without querying: %j", async (filters) => {
    await expect(findCandidates({ mustHave: ["AWS"], ...filters })).rejects.toThrow();
    expect(searchCandidates).not.toHaveBeenCalled();
  });

  it("accepts leap day and independently open-ended bounds", async () => {
    await findCandidates({ mustHave: ["AWS"], dateAddedStart: "2024-02-29" });
    expect(vi.mocked(searchCandidates).mock.calls[0][0].query).toBe("NOT status:Archive");
    await findCandidates({ mustHave: ["AWS"], dateAddedEnd: "2024-03-01" });
    expect(vi.mocked(searchCandidates).mock.calls[1][0].query).toBe("NOT status:Archive");
  });

  it("escapes exclusions and removes exact statuses before ranking without inventing aliases", async () => {
    const quoted = 'Hold "review" \\ pending';
    mockState.pool = [
      { id: 1, status: "PLACED", skillSet: "AWS" },
      { id: 2, status: "DNU", skillSet: "AWS" },
      { id: 3, status: "Do Not Use", skillSet: "AWS" },
      { id: 4, status: quoted, skillSet: "AWS" },
      { id: 5, status: "New Lead", skillSet: "AWS" },
    ];
    const result = await findCandidates({ mustHave: ["AWS"], excludedStatuses: [" Placed ", "placed", "DNU", quoted] }) as any;
    expect(result.matches.map((m: any) => m.candidateId).sort()).toEqual([3, 5]);
    const query = vi.mocked(searchCandidates).mock.calls[0][0].query;
    expect(query).toBe("NOT status:Archive"); // No lossy exact-status pushdown.
    expect(result.appliedFilters.excludedStatuses).toEqual(["Placed", "DNU", quoted]);
    expect(vi.mocked(getCandidate).mock.calls.map(([arg]) => arg.id).sort()).toEqual([3, 5]);
  });

  it("retains synonym groups and reports preferences, unsupported contact exclusion and pool limits", async () => {
    mockState.pool = [{ id: 1, status: "New Lead", skillSet: "AWS Java", address: { city: "Toronto" } }];
    const result = await findCandidates({ mustHave: ["AWS", "Java"], city: "Ottawa", state: "Ontario", limit: 1 }) as any;
    const keywords = vi.mocked(searchCandidates).mock.calls[0][0].keywords!;
    expect(keywords).toHaveLength(2);
    expect(keywords[0]).toContain("amazon web services");
    expect(result.query.expandedTo[0]).toContain("amazon web services");
    expect(result.matches).toHaveLength(1); // Nonlocal is retained, not hard-filtered.
    expect(result.appliedFilters.location).toEqual({ city: "Ottawa", state: "Ontario", mode: "ranking_preference" });
    expect(result.appliedFilters.contactHistoryExclusion).toEqual({ supported: false, applied: false });
    expect(result.searchScope).toEqual({ exhaustive: false, requestedFiltersPushedDown: false, poolRequested: 60, fetched: 1, eligibleInFetchedPool: 1, resumeCheckLimit: 2, resultLimit: 1 });
    expect(result.notes.join(" ")).toContain("not an exhaustive search");
  });

  it("produces identical results for the same mocked pool, evidence and clock", async () => {
    mockState.pool = [{ id: 2, skillSet: "AWS" }, { id: 1, skillSet: "AWS" }];
    const args = { mustHave: ["AWS"] };
    expect(await findCandidates(args)).toEqual(await findCandidates(args));
  });
});
