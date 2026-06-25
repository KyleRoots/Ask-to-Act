import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the Bullhorn data layer so we can test the matcher's deterministic
// filtering/ranking in isolation. matchCandidatesForJob reads the job (getJob),
// searches a pool (searchCandidates), checks who is already submitted
// (listSubmissionsForJob), and pulls résumé evidence (getCandidateResume).
// The trust-critical behaviors under test: default exclusions, submission match
// by candidate ID (NOT name), local prioritization, and include* overrides.
// ---------------------------------------------------------------------------
const mockState = vi.hoisted(() => ({
  job: {} as Record<string, unknown>,
  pool: [] as unknown[],
  submissions: [] as unknown[],
}));

vi.mock("./bullhorn-client.js", () => ({
  getJob: vi.fn(async () => mockState.job),
  // Mirror the live search contract: when the matcher restricts to the workable
  // pool via `NOT status:Archive`, archived candidates must not be returned. When
  // includeInactive drops that clause, everything comes back.
  searchCandidates: vi.fn(async (args: { query?: string }) => {
    let pool = mockState.pool as Array<{ status?: string }>;
    if (args.query && /NOT status:Archive/i.test(args.query)) {
      pool = pool.filter((c) => !/archive/i.test(c.status ?? ""));
    }
    return { data: pool };
  }),
  // Mirror Bullhorn paging so the matcher's exhaustive submission fetch is exercised.
  listSubmissionsForJob: vi.fn(async (args: { count?: number; start?: number }) => {
    const start = args.start ?? 0;
    const count = args.count ?? 200;
    return { data: (mockState.submissions as unknown[]).slice(start, start + count) };
  }),
  getCandidateResume: vi.fn(async (args: { candidateId: number; highlight?: string[] }) => ({
    matchedTerms: args.highlight ?? [],
    excerpts: [{ term: (args.highlight ?? [])[0] ?? "", text: "…evidence quote…" }],
  })),
}));

const { matchCandidatesForJob } = await import("./matching.js");

type Match = {
  candidateId: number;
  name: string;
  status: string;
  isLocal: boolean;
  alreadySubmitted: boolean;
};
type Result = {
  job: { skillsMatchedAgainst: string[]; location: string };
  defaultsApplied: { excludedByDefault: string[]; localPriority: boolean };
  totals: { candidatesScanned: number; matchesReturned: number };
  matches: Match[];
};

function candidate(
  id: number,
  name: string,
  status: string,
  opts: { city?: string; state?: string; skillSet?: string } = {},
) {
  return {
    id,
    name,
    status,
    occupation: "Engineer",
    skillSet: opts.skillSet ?? "Python, Pytest",
    address: { city: opts.city ?? "Toronto", state: opts.state ?? "ON" },
    bullhornUrl: `https://bh.example/candidate/${id}`,
  };
}

beforeEach(() => {
  mockState.job = {
    id: 35233,
    title: "Python Test Developer",
    skills: "Python, Pytest, Selenium",
    publicDescription: "Onsite role in Ottawa. Python test automation.",
    address: { city: "Ottawa", state: "ON" },
    employmentType: "Contract",
    bullhornUrl: "https://bh.example/job/35233",
  };
  mockState.pool = [];
  mockState.submissions = [];
});

describe("matchCandidatesForJob", () => {
  it("derives requirements from the job and returns workable matches with deep links", async () => {
    mockState.pool = [
      candidate(1, "Amer Abdulkader", "Online Applicant", { city: "Ottawa" }),
      candidate(2, "Sergei Berezov", "New Lead", { city: "Toronto" }),
    ];
    const r = (await matchCandidatesForJob({ jobId: 35233 })) as Result;

    expect(r.job.skillsMatchedAgainst).toEqual(["Python", "Pytest", "Selenium"]);
    expect(r.matches.map((m) => m.candidateId)).toContain(1);
    expect((r.matches[0] as unknown as { bullhornUrl: string }).bullhornUrl).toMatch(/candidate\/1/);
  });

  it("excludes Placed, Inactive/Archived, and Do-Not-Contact candidates by default", async () => {
    mockState.pool = [
      candidate(1, "Good One", "Online Applicant"),
      candidate(2, "Placed Person", "Placed"),
      candidate(3, "Archived Person", "Archive"),
      candidate(4, "DNC Person", "Do Not Contact"),
    ];
    const r = (await matchCandidatesForJob({ jobId: 35233 })) as Result;
    const ids = r.matches.map((m) => m.candidateId);
    expect(ids).toEqual([1]);
    expect(r.defaultsApplied.excludedByDefault).toContain("Placed");
  });

  it("excludes someone ALREADY SUBMITTED by candidate ID, not by name", async () => {
    // Two different people share the name "Ivan Novikov": id 10 is submitted,
    // id 11 is NOT. Name-based matching would wrongly exclude both; ID-based
    // matching must exclude only id 10.
    mockState.pool = [
      candidate(10, "Ivan Novikov", "Online Applicant"),
      candidate(11, "Ivan Novikov", "Online Applicant"),
    ];
    mockState.submissions = [{ id: 999, candidate: { id: 10 }, status: "New Lead" }];

    const r = (await matchCandidatesForJob({ jobId: 35233 })) as Result;
    const ids = r.matches.map((m) => m.candidateId);
    expect(ids).toContain(11);
    expect(ids).not.toContain(10);
  });

  it("can include already-submitted candidates when asked, flagging them", async () => {
    mockState.pool = [candidate(10, "Ivan Novikov", "Online Applicant")];
    mockState.submissions = [{ id: 999, candidate: { id: 10 }, status: "New Lead" }];

    const r = (await matchCandidatesForJob({
      jobId: 35233,
      includeSubmitted: true,
    })) as Result;
    expect(r.matches.map((m) => m.candidateId)).toContain(10);
    expect(r.matches.find((m) => m.candidateId === 10)?.alreadySubmitted).toBe(true);
  });

  it("prioritizes local candidates but still surfaces strong remote ones by default", async () => {
    mockState.pool = [
      candidate(1, "Remote Strong", "Online Applicant", { city: "Vancouver", state: "BC" }),
      candidate(2, "Local Person", "Online Applicant", { city: "Ottawa", state: "ON" }),
    ];
    const r = (await matchCandidatesForJob({ jobId: 35233 })) as Result;
    // Local ranked first, remote still present.
    expect(r.matches[0].candidateId).toBe(2);
    expect(r.matches.map((m) => m.candidateId)).toContain(1);
  });

  it("excludes already-submitted candidates even when submissions span multiple pages", async () => {
    // Trust-critical at scale: a job with >200 submissions must still produce a
    // COMPLETE submitted-id set. Candidate 500 is submitted but sits on page 2.
    mockState.pool = [
      candidate(500, "Late Page Submitter", "Online Applicant"),
      candidate(501, "Never Submitted", "Online Applicant"),
    ];
    const subs: unknown[] = [];
    for (let i = 0; i < 250; i++) {
      subs.push({ id: i, candidate: { id: i === 230 ? 500 : 9000 + i }, status: "New Lead" });
    }
    mockState.submissions = subs;

    const r = (await matchCandidatesForJob({ jobId: 35233 })) as Result;
    const ids = r.matches.map((m) => m.candidateId);
    expect(ids).not.toContain(500);
    expect(ids).toContain(501);
  });

  it("includeInactive surfaces archived candidates the override is meant to return", async () => {
    mockState.pool = [
      candidate(1, "Workable", "Online Applicant"),
      candidate(2, "Archived Person", "Archive"),
    ];
    const r = (await matchCandidatesForJob({ jobId: 35233, includeInactive: true })) as Result;
    expect(r.matches.map((m) => m.candidateId)).toContain(2);
  });

  it("localOnly drops out-of-area candidates entirely", async () => {
    mockState.pool = [
      candidate(1, "Remote Person", "Online Applicant", { city: "Vancouver", state: "BC" }),
      candidate(2, "Local Person", "Online Applicant", { city: "Ottawa", state: "ON" }),
    ];
    const r = (await matchCandidatesForJob({ jobId: 35233, localOnly: true })) as Result;
    expect(r.matches.map((m) => m.candidateId)).toEqual([2]);
  });
});
