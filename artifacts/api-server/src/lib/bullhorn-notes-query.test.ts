import { describe, it, expect } from "vitest";
import {
  parseJobIdsFromNoteComments,
  noteReferencesJob,
  countEntity,
  getNotes,
} from "./bullhorn-client.js";

describe("parseJobIdsFromNoteComments", () => {
  it("extracts Job ID values from Scout-style comments", () => {
    expect(
      parseJobIdsFromNoteComments(
        "APPLIED POSITION:\n• Job ID: 35501 - Senior Project Manager\n• Job ID: 36000 - Other",
      ),
    ).toEqual([35501, 36000]);
  });

  it("returns [] for empty/non-string input", () => {
    expect(parseJobIdsFromNoteComments(null)).toEqual([]);
    expect(parseJobIdsFromNoteComments("")).toEqual([]);
  });
});

describe("noteReferencesJob", () => {
  it("matches jobOrder.id association", () => {
    expect(
      noteReferencesJob({ jobOrder: { id: 35501 }, comments: "" }, 35501),
    ).toBe(true);
  });

  it("matches Job ID in comments when jobOrder is null", () => {
    expect(
      noteReferencesJob(
        { jobOrder: null, comments: "Job ID: 35501 - title" },
        35501,
      ),
    ).toBe(true);
    expect(
      noteReferencesJob(
        { jobOrder: null, comments: "Job ID: 35501 - title" },
        99999,
      ),
    ).toBe(false);
  });
});

describe("countEntity Note guard", () => {
  it("rejects Note instead of returning a false Lucene zero", async () => {
    await expect(countEntity({ entityType: "Note" })).rejects.toThrow(
      /get_notes/,
    );
  });
});

describe("getNotes requires a parent id", () => {
  it("throws when neither candidateId nor jobId is provided", async () => {
    await expect(getNotes({})).rejects.toThrow(/candidateId|jobId/);
  });
});
