import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the Bullhorn data layer so we can test the matcher's deterministic
// filtering/ranking in isolation.
// ---------------------------------------------------------------------------
const mockState = vi.hoisted(() => ({
  job: {} as Record<string, unknown>,
  pool: [] as unknown[],
  submissions: [] as unknown[],
  candidates: new Map<number, Record<string, unknown>>(),
}));

vi.mock("./bullhorn-client.js", () => ({
  getJob: vi.fn(async () => mockState.job),
  searchCandidates: vi.fn(async (args: { query?: string }) => {
    let pool = mockState.pool as Array<{ status?: string }>;
    if (args.query && /NOT status:Archive/i.test(args.query)) {
      pool = pool.filter((c) => !/archive/i.test(c.status ?? ""));
    }
    return { data: pool };
  }),
  listSubmissionsForJob: vi.fn(async (args: { count?: number; start?: number }) => {
    const start = args.start ?? 0;
    const count = args.count ?? 200;
    return { data: (mockState.submissions as unknown[]).slice(start, start + count) };
  }),
  getCandidateResume: vi.fn(async (args: { candidateId: number; highlight?: string[] }) => ({
    matchedTerms: args.highlight ?? [],
    excerpts: [{ term: (args.highlight ?? [])[0] ?? "", text: "…evidence quote…" }],
  })),
  getCandidate: vi.fn(async (args: { id: number }) => {
    return (
      mockState.candidates.get(args.id) ?? {
        id: args.id,
        workHistories: { data: [] },
      }
    );
  }),
}));

const { matchCandidatesForJob } = await import("./matching.js");

type Match = {
  candidateId: number;
  name: string;
  status: string;
  isLocal: boolean;
  alreadySubmitted: boolean;
  alreadyApplied: boolean;
  needsVerification?: boolean;
};
type Result = {
  status: string;
  job: {
    skillsMatchedAgainst: string[];
    location: string;
    locationRequirement: string;
  };
  defaultsApplied: { excludedByDefault: string[]; localPriority: boolean; preferLocal?: boolean };
  totals: { candidatesScanned: number; matchesReturned: number };
  matches: Match[];
  eligibleMatches?: Match[];
  needsVerification?: Match[];
  presentationGuidance?: string[];
  completeness?: { stopReasons: string[] };
};

function candidate(
  id: number,
  name: string,
  status: string,
  opts: {
    city?: string;
    state?: string;
    skillSet?: string;
    workAuthorized?: boolean;
    willRelocate?: boolean;
  } = {},
) {
  return {
    id,
    name,
    status,
    occupation: "Engineer",
    skillSet: opts.skillSet ?? "Python, Pytest",
    address: { city: opts.city ?? "Toronto", state: opts.state ?? "ON" },
    workAuthorized: opts.workAuthorized ?? true,
    willRelocate: opts.willRelocate,
    bullhornUrl: `https://bh.example/candidate/${id}`,
  };
}

beforeEach(() => {
  mockState.job = {
    id: 35233,
    title: "Python Test Developer",
    skills: "Python, Pytest, Selenium",
    publicDescription: "Onsite role in Ottawa. Python test automation.",
    onSite: ["Onsite"],
    address: { city: "Ottawa", state: "ON" },
    employmentType: "Contract",
    yearsRequired: 3,
    willSponsor: true,
    bullhornUrl: "https://bh.example/job/35233",
  };
  mockState.pool = [];
  mockState.submissions = [];
  mockState.candidates = new Map();
});

describe("matchCandidatesForJob", () => {
  it("derives requirements from the job and returns workable matches with deep links", async () => {
    mockState.pool = [
      candidate(1, "Amer Abdulkader", "Online Applicant", { city: "Ottawa" }),
      candidate(2, "Sergei Berezov", "New Lead", { city: "Toronto" }),
    ];
    const r = (await matchCandidatesForJob({ jobId: 35233 })) as Result;

    expect(r.job.skillsMatchedAgainst).toEqual(["Python", "Pytest", "Selenium"]);
    expect(r.job.locationRequirement).toBe("onsite");
    expect(r.matches.map((m) => m.candidateId)).toContain(1);
    expect((r.matches[0] as unknown as { bullhornUrl: string }).bullhornUrl).toMatch(/candidate\/1/);
    expect(r.presentationGuidance?.length).toBeGreaterThan(0);
  });

  it("excludes Placed, Inactive/Archived, and Do-Not-Contact candidates by default", async () => {
    mockState.pool = [
      candidate(1, "Good One", "Online Applicant", { city: "Ottawa" }),
      candidate(2, "Placed Person", "Placed", { city: "Ottawa" }),
      candidate(3, "Archived Person", "Archive", { city: "Ottawa" }),
      candidate(4, "DNC Person", "Do Not Contact", { city: "Ottawa" }),
    ];
    const r = (await matchCandidatesForJob({ jobId: 35233 })) as Result;
    const ids = r.matches.map((m) => m.candidateId);
    expect(ids).toEqual([1]);
    expect(r.defaultsApplied.excludedByDefault).toContain("Placed");
  });

  it("excludes someone ALREADY SUBMITTED by candidate ID, not by name", async () => {
    mockState.pool = [
      candidate(10, "Ivan Novikov", "Online Applicant", { city: "Ottawa" }),
      candidate(11, "Ivan Novikov", "Online Applicant", { city: "Ottawa" }),
    ];
    mockState.submissions = [{ id: 999, candidate: { id: 10 }, status: "Client Submission" }];

    const r = (await matchCandidatesForJob({ jobId: 35233 })) as Result;
    const ids = r.matches.map((m) => m.candidateId);
    expect(ids).toContain(11);
    expect(ids).not.toContain(10);
  });

  it("does NOT exclude inbound applicants (Response bucket) — shows them flagged alreadyApplied", async () => {
    mockState.pool = [candidate(20, "Applied Only", "Online Applicant", { city: "Ottawa" })];
    mockState.submissions = [{ id: 999, candidate: { id: 20 }, status: "New Lead" }];

    const r = (await matchCandidatesForJob({ jobId: 35233 })) as Result;
    const m = r.matches.find((x) => x.candidateId === 20);
    expect(m).toBeDefined();
    expect(m?.alreadySubmitted).toBe(false);
    expect((m as unknown as { alreadyApplied: boolean }).alreadyApplied).toBe(true);
  });

  it("can include already-submitted candidates when asked, flagging them", async () => {
    mockState.pool = [candidate(10, "Ivan Novikov", "Online Applicant", { city: "Ottawa" })];
    mockState.submissions = [{ id: 999, candidate: { id: 10 }, status: "Client Submission" }];

    const r = (await matchCandidatesForJob({
      jobId: 35233,
      includeSubmitted: true,
    })) as Result;
    expect(r.matches.map((m) => m.candidateId)).toContain(10);
    expect(r.matches.find((m) => m.candidateId === 10)?.alreadySubmitted).toBe(true);
  });

  it("prioritizes local candidates but still surfaces strong remote ones by default for onsite", async () => {
    mockState.pool = [
      candidate(1, "Remote Strong", "Online Applicant", {
        city: "Vancouver",
        state: "BC",
        willRelocate: true,
      }),
      candidate(2, "Local Person", "Online Applicant", { city: "Ottawa", state: "ON" }),
    ];
    const r = (await matchCandidatesForJob({ jobId: 35233 })) as Result;
    expect(r.matches[0].candidateId).toBe(2);
    expect(r.matches.map((m) => m.candidateId)).toContain(1);
    expect(r.defaultsApplied.preferLocal).toBe(true);
  });

  it("does not prefer local-address ranking for explicit remote jobs", async () => {
    mockState.job = {
      ...mockState.job,
      onSite: ["Remote"],
      isWorkFromHome: true,
      publicDescription: "Fully remote technical recruiter supporting North America.",
      address: { city: "Cairo", state: "" },
    };
    mockState.pool = [
      candidate(1, "Near Address", "Online Applicant", { city: "Cairo", state: "" }),
      candidate(2, "Far Strong", "Online Applicant", {
        city: "Vancouver",
        state: "BC",
        skillSet: "Python, Pytest, Selenium",
      }),
    ];
    const r = (await matchCandidatesForJob({ jobId: 35233 })) as Result;
    expect(r.job.locationRequirement).toBe("remote");
    expect(r.defaultsApplied.preferLocal).toBe(false);
    // Both should be eligible; local boost must not force Cairo first solely by address.
    expect(r.matches.map((m) => m.candidateId).sort()).toEqual([1, 2]);
  });

  it("excludes already-submitted candidates even when submissions span multiple pages", async () => {
    mockState.pool = [
      candidate(500, "Late Page Submitter", "Online Applicant", { city: "Ottawa" }),
      candidate(501, "Never Submitted", "Online Applicant", { city: "Ottawa" }),
    ];
    const subs: unknown[] = [];
    for (let i = 0; i < 250; i++) {
      subs.push({ id: i, candidate: { id: i === 230 ? 500 : 9000 + i }, status: "Client Submission" });
    }
    mockState.submissions = subs;

    const r = (await matchCandidatesForJob({ jobId: 35233 })) as Result;
    const ids = r.matches.map((m) => m.candidateId);
    expect(ids).not.toContain(500);
    expect(ids).toContain(501);
  });

  it("includeInactive surfaces archived candidates the override is meant to return", async () => {
    mockState.pool = [
      candidate(1, "Workable", "Online Applicant", { city: "Ottawa" }),
      candidate(2, "Archived Person", "Archive", { city: "Ottawa" }),
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

  it("excludes unauthorized candidates when the job will not sponsor", async () => {
    mockState.job = { ...mockState.job, willSponsor: false };
    mockState.pool = [
      candidate(1, "Authorized", "Online Applicant", { city: "Ottawa", workAuthorized: true }),
      candidate(2, "Unauthorized", "Online Applicant", { city: "Ottawa", workAuthorized: false }),
    ];
    const r = (await matchCandidatesForJob({ jobId: 35233 })) as Result;
    expect(r.matches.map((m) => m.candidateId)).toEqual([1]);
  });

  it("marks title-token skill derivation as partial completeness", async () => {
    mockState.job = {
      ...mockState.job,
      skills: "",
      skillList: "",
      title: "Senior Python Developer",
    };
    mockState.pool = [candidate(1, "Dev", "Online Applicant", { city: "Ottawa", skillSet: "Python" })];
    const r = (await matchCandidatesForJob({ jobId: 35233 })) as Result;
    expect(r.status).toBe("partial");
    expect(r.completeness?.stopReasons).toContain("skills_derived_from_title_tokens");
  });
});
