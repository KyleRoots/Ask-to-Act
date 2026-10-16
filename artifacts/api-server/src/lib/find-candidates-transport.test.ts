import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real candidate query builder/adapter, synthetic session and mocked HTTP only.
vi.mock("./bullhorn-auth.js", () => ({
  getSession: vi.fn(async () => ({ restUrl: "https://transport.invalid/rest/", BhRestToken: "synthetic" })),
  invalidateSession: vi.fn(), currentFirmContextId: () => "synthetic-firm",
}));
vi.mock("./firm-config.js", () => ({ resolveDeptField: vi.fn() }));
vi.mock("./cache.js", () => ({ cacheGet: () => undefined, cacheSet: vi.fn() }));
vi.mock("./logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./search-verify.js", () => ({
  verifyConcepts: vi.fn(async () => new Map()), confirmedConceptIds: () => new Set(),
}));
import { searchCandidates } from "./bullhorn-client.js";
import { findCandidates } from "./find-candidates.js";

let pool: Array<Record<string, unknown>>;
let requests: URL[];
beforeEach(() => {
  pool = []; requests = [];
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 16));
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = new URL(String(input)); requests.push(url);
    if (url.origin !== "https://transport.invalid") throw new Error("Unexpected transport origin");
    if (url.pathname === "/rest/search/Candidate") return Response.json({ data: pool });
    const id = /^\/rest\/entity\/Candidate\/(\d+)$/.exec(url.pathname)?.[1];
    if (id) return Response.json({ data: pool.find((row) => row.id === Number(id)) });
    throw new Error("Unexpected transport path");
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const searchQuery = () => requests.find((u) => u.pathname.endsWith("/search/Candidate"))!.searchParams.get("query")!;

describe("candidate composition at the real mocked transport boundary", () => {
  it("anchors a nested exclusion-only structured clause beside keyword alternatives", async () => {
    await searchCandidates({ keywords: ["AWS"], query: 'NOT status:"Placed"' });
    expect(searchQuery()).toContain('(id:[1 TO *] AND NOT status:"Placed")');
    expect(searchQuery()).not.toContain('(NOT status:"Placed")');
    expect(searchQuery()).toContain('description:"AWS"');
  });
  it("anchors the default Archive exclusion used by find_candidates", async () => {
    await findCandidates({ mustHave: ["AWS"] });
    expect(searchQuery()).toContain('(id:[1 TO *] AND NOT status:Archive)');
  });
  it("preserves a positive condition and caller-escaped status text", async () => {
    const clause = 'status:"Hold \\"review\\" \\\\ pending" AND dateAdded:[20260308000000 TO *]';
    await searchCandidates({ keywords: ["AWS"], query: clause });
    expect(searchQuery()).toContain(`(${clause})`);
    expect(searchQuery()).not.toContain("id:[1 TO *]");
  });
  it.each([
    'status:Active OR status:Placed',
    'status:Active AND NOT status:Placed',
    'NOT status:Archive AND status:Active',
    '(status:Active OR status:Placed) AND NOT status:Archive',
    'NOT status:Archive OR NOT status:Placed',
  ])("preserves positive, mixed and OR structured clauses: %s", async (clause) => {
    await searchCandidates({ keywords: ["AWS"], query: clause });
    expect(searchQuery()).toBe(`(description:"AWS" OR skillSet:"AWS" OR comments:"AWS" OR occupation:"AWS") AND (${clause})`);
  });
  it("reports positive status as unverified upstream phrase without pretending local equality", async () => {
    pool = [{ id: 1, status: "Previously Active", skillSet: "AWS" }];
    const result = await findCandidates({ mustHave: ["AWS"], status: "Active" }) as any;
    expect(searchQuery()).toContain('(NOT status:Archive AND status:"Active")');
    expect(result.matches.map((row: any) => row.candidateId)).toEqual([1]);
    expect(result.appliedFilters).not.toHaveProperty("exactStatus");
    expect(result.appliedFilters.upstreamStatus).toEqual({ requestedPhrase: "Active", applied: true, wholeFieldEqualityVerified: false });
  });
  it("does not claim a positive status phrase was applied when absent", async () => {
    const result = await findCandidates({ mustHave: ["AWS"] }) as any;
    expect(result.appliedFilters.upstreamStatus).toEqual({ requestedPhrase: null, applied: false, wholeFieldEqualityVerified: false });
  });
  it.each([
    'NOT status:Archive status:Active',
    'NOT status:"Do Not Contact" status:Active',
    'NOT status:Archive AND status:Active',
    'NOT status:Archive OR NOT status:Placed',
    'NOT dateAdded:[20260308000000 TO 20260309000000]',
    'NOT status:[Archive TO Placed]',
    '(NOT status:Archive)',
    'NOT (status:Archive OR status:Placed)',
    'NOT status:Archive AND (NOT status:Placed)',
    'NOT status:"unterminated',
  ])("does not classify unsupported or implicit mixed syntax as pure negative: %s", async (clause) => {
    await searchCandidates({ keywords: ["AWS"], query: clause });
    expect(searchQuery()).toBe(`(description:"AWS" OR skillSet:"AWS" OR comments:"AWS" OR occupation:"AWS") AND (${clause})`);
  });
  it.each([
    'NOT status:Archive AND NOT status:Placed',
    'NOT status:"Do Not Contact"',
    'NOT status:"Hold AND review"',
    'NOT status:"Hold OR review"',
    String.raw`NOT status:"Hold \"review\""`,
    String.raw`NOT status:"Trailing\\"`,
  ])("anchors only complete simple negative status clauses, including quoted text: %s", async (clause) => {
    await searchCandidates({ keywords: ["AWS"], query: clause });
    expect(searchQuery()).toBe(`(description:"AWS" OR skillSet:"AWS" OR comments:"AWS" OR occupation:"AWS") AND (id:[1 TO *] AND ${clause})`);
  });
  it("keeps the unfiltered keyword-only baseline query unchanged", async () => {
    await searchCandidates({ keywords: ["AWS"] });
    expect(searchQuery()).toBe('(description:"AWS" OR skillSet:"AWS" OR comments:"AWS" OR occupation:"AWS")');
  });
  it("does not send exact-status or subsecond date assumptions upstream", async () => {
    const start = Date.parse("2026-03-08T00:00:00Z"), end = Date.parse("2026-03-09T00:00:00Z");
    pool = [
      { id: 1, status: "Placed", dateAdded: start },
      { id: 2, status: "Previously Placed", dateAdded: end - 1 },
      { id: 3, status: 'Hold "review" \\ pending', dateAdded: start },
      { id: 4, status: "New Lead", dateAdded: end },
      { id: 5, status: "New Lead" },
    ];
    const result = await findCandidates({ mustHave: ["AWS"], includeInactive: true, excludedStatuses: ["Placed", 'Hold "review" \\ pending'], dateAddedStart: "2026-03-08", dateAddedEnd: "2026-03-09" }) as any;
    expect(searchQuery()).not.toContain("status:");
    expect(searchQuery()).not.toContain("dateAdded:");
    expect(result.matches.map((row: any) => row.candidateId)).toEqual([2]);
    expect(requests.filter((u) => u.pathname.includes("/entity/")).map((u) => u.pathname)).toEqual(["/rest/entity/Candidate/2"]);
    expect(result.searchScope.requestedFiltersPushedDown).toBe(false);
    expect(result.appliedFilters.requestedFilterStage).toBe("fetched_pool_before_ranking");
  });
  it("rejects missing-date rows before detail reads when bounds are requested", async () => {
    pool = [{ id: 1, status: "New Lead" }, { id: 2, dateAdded: "not a timestamp" }];
    const result = await findCandidates({ mustHave: ["AWS"], dateAddedStart: "2026-03-08" }) as any;
    expect(result.matches).toEqual([]);
    expect(requests).toHaveLength(1);
  });
  it("returns an explicitly bounded empty result without claiming the universe is empty", async () => {
    const result = await findCandidates({ mustHave: ["AWS"] }) as any;
    expect(result.matches).toEqual([]);
    expect(result.searchScope.exhaustive).toBe(false);
    expect(result.notes.join(" ")).toContain("an empty result does not establish no eligible candidates exist");
    expect(requests).toHaveLength(1);
  });
});
