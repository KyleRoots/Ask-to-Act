import { describe, it, expect } from "vitest";
import { buildNotesWhereClause, countEntity } from "./bullhorn-client.js";

describe("buildNotesWhereClause", () => {
  it("ORs personReference and candidates for candidate filters", () => {
    expect(buildNotesWhereClause({ candidateId: 4672021 })).toBe(
      "(personReference.id=4672021 OR candidates.id=4672021)",
    );
  });

  it("filters by jobOrder.id", () => {
    expect(buildNotesWhereClause({ jobId: 35501 })).toBe("jobOrder.id=35501");
  });

  it("combines candidate, job, and date range", () => {
    expect(
      buildNotesWhereClause({
        candidateId: 10,
        jobId: 20,
        dateAddedStart: "2026-01-01",
        dateAddedEnd: "2026-02-01",
      }),
    ).toBe(
      "(personReference.id=10 OR candidates.id=10) AND jobOrder.id=20 AND dateAdded >= 1767225600000 AND dateAdded < 1769904000000",
    );
  });

  it("uses id>0 when no filters are given", () => {
    expect(buildNotesWhereClause({})).toBe("id>0");
  });
});

describe("countEntity Note guard", () => {
  it("rejects Note instead of returning a false Lucene zero", async () => {
    await expect(countEntity({ entityType: "Note" })).rejects.toThrow(
      /query_entity|get_notes/,
    );
  });
});
