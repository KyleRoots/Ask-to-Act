import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the Bullhorn data layer so we can test the recruiter conversion math in
// isolation. recruiterLeaderboard pulls placements (with the originating
// submission's sendingUser) via listPlacements, and counts each recruiter's
// submissions via countEntity. We feed controlled fixtures and assert that
// conversion is credited to the SUBMITTER, bounded, and ordered sensibly.
// ---------------------------------------------------------------------------
const mockState = vi.hoisted(() => ({
  placements: [] as unknown[],
  submissionCounts: {} as Record<number, number>,
}));

vi.mock("./bullhorn-client.js", () => ({
  ACTIVE_OPPS_DEFINITION: "active-opps-test-stub",
  listPlacements: vi.fn(async (args: { start?: number }) => {
    // Single page: everything on start=0, empty afterwards so paging terminates.
    if ((args.start ?? 0) > 0) return { data: [] };
    return { data: mockState.placements };
  }),
  countEntity: vi.fn(async (args: { query?: string }) => {
    const m = /sendingUser\.id:(\d+)/.exec(args.query ?? "");
    const id = m ? Number(m[1]) : -1;
    return { total: mockState.submissionCounts[id] ?? 0 };
  }),
}));

const { recruiterLeaderboard } = await import("./reports.js");

type Row = {
  rank: number;
  recruiter: string;
  submissions: number;
  placementsFromSubmissions: number;
  conversionRate: number | null;
  lowVolume: boolean;
  cappedAt100?: boolean;
};

function confirmedPlacement(senderId: number | null, ownerId: number, name: string) {
  return {
    id: Math.floor(Math.random() * 1e6),
    status: "Approved",
    dateAdded: Date.UTC(2026, 2, 1),
    owner: { id: ownerId, name: `Owner ${ownerId}` },
    jobSubmission:
      senderId === null ? undefined : { id: 1, sendingUser: { id: senderId, name } },
  };
}

beforeEach(() => {
  mockState.placements = [];
  mockState.submissionCounts = {};
});

describe("recruiterLeaderboard conversion attribution", () => {
  it("credits the submitter (not the placement owner) and bounds the rate", async () => {
    // Bob (id 2) submitted 5 confirmed placements, all OWNED by a different person (id 1).
    for (let i = 0; i < 5; i++) mockState.placements.push(confirmedPlacement(2, 1, "Bob"));
    // Cara (id 3) submitted 1 confirmed placement.
    mockState.placements.push(confirmedPlacement(3, 3, "Cara"));
    // One confirmed placement with no submission sender -> unattributed.
    mockState.placements.push(confirmedPlacement(null, 9, "Ghost"));
    // A non-confirmed placement (Submitted) should be ignored even though Bob sent it.
    mockState.placements.push({ ...confirmedPlacement(2, 1, "Bob"), status: "Submitted" });

    mockState.submissionCounts = { 2: 50, 3: 1 };

    const result = (await recruiterLeaderboard({})) as {
      scope: string;
      rows: Row[];
      totals: { placementsFromSubmissions: number; unattributedPlacements: number };
    };

    expect(result.scope).toBe("submitting_recruiter");

    const bob = result.rows.find((r) => r.recruiter === "Bob")!;
    expect(bob.submissions).toBe(50);
    expect(bob.placementsFromSubmissions).toBe(5);
    expect(bob.conversionRate).toBe(10);
    expect(bob.lowVolume).toBe(false);

    const cara = result.rows.find((r) => r.recruiter === "Cara")!;
    expect(cara.conversionRate).toBe(100);
    expect(cara.lowVolume).toBe(true);

    // Reliable Bob outranks the 1/1=100% low-volume fluke.
    expect(bob.rank).toBeLessThan(cara.rank);
    expect(bob.rank).toBe(1);

    expect(result.totals.placementsFromSubmissions).toBe(6);
    expect(result.totals.unattributedPlacements).toBe(1);
  });

  it("covers the same period window for placements and submissions when endDate is omitted", async () => {
    mockState.placements = [confirmedPlacement(2, 1, "Bob")];
    mockState.submissionCounts = { 2: 20 };

    const bh = await import("./bullhorn-client.js");
    (bh.listPlacements as ReturnType<typeof vi.fn>).mockClear();
    (bh.countEntity as ReturnType<typeof vi.fn>).mockClear();

    const before = Date.now();
    await recruiterLeaderboard({ startDate: "2026-01-01" });
    const after = Date.now();

    const plArgs = (bh.listPlacements as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      dateAddedEnd: string;
    };
    const placementEndMs = Date.parse(plArgs.dateAddedEnd);
    // Placement end must be "now" (today included), NOT midnight today.
    expect(placementEndMs).toBeGreaterThanOrEqual(before);
    expect(placementEndMs).toBeLessThanOrEqual(after + 1000);

    const subCall = (bh.countEntity as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => /sendingUser\.id:2/.test((c[0] as { query: string }).query),
    )!;
    const subEndMs = Number(
      /dateAdded:\[\d+ TO (\d+)\]/.exec((subCall[0] as { query: string }).query)![1],
    );
    // Both windows must end at the same instant (within a small tolerance).
    expect(Math.abs(subEndMs - placementEndMs)).toBeLessThan(2000);
  });

  it("caps the rate at 100% when a submission predates the period", async () => {
    // Dan (id 4): 12 confirmed placements credited to him, but only 10 submissions
    // within the period (2 placements stem from prior-period submissions).
    for (let i = 0; i < 12; i++) mockState.placements.push(confirmedPlacement(4, 4, "Dan"));
    mockState.submissionCounts = { 4: 10 };

    const result = (await recruiterLeaderboard({})) as { rows: Row[] };
    const dan = result.rows.find((r) => r.recruiter === "Dan")!;
    expect(dan.placementsFromSubmissions).toBe(12);
    expect(dan.submissions).toBe(10);
    expect(dan.conversionRate).toBe(100);
    expect(dan.cappedAt100).toBe(true);
    expect(dan.lowVolume).toBe(false);
  });
});
