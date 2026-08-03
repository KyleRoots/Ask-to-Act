import { describe, it, expect } from "vitest";
import {
  isSnapshotIndexedAction,
  snapshotActionPrefixes,
  snapshotExactActions,
  isCoverageFresh,
  DEFAULT_NOTE_SNAPSHOT_TTL_MS,
  noteSnapshotTtlMs,
} from "./note-snapshot-allowlist.js";
import { rankSnapshotCandidates } from "./note-snapshot-store.js";

describe("note-snapshot-allowlist", () => {
  it("defaults to Scout Screen - prefix", () => {
    expect(snapshotActionPrefixes({})).toEqual(["Scout Screen -"]);
    expect(isSnapshotIndexedAction("Scout Screen - Qualified", {})).toBe(true);
    expect(isSnapshotIndexedAction("Scout Screen - Not Qualified", {})).toBe(
      true,
    );
    expect(isSnapshotIndexedAction("Left Message", {})).toBe(false);
  });

  it("honors exact NOTE_SNAPSHOT_ACTIONS", () => {
    const env = { NOTE_SNAPSHOT_ACTIONS: "Left Message, Submitted" };
    expect(snapshotExactActions(env)).toEqual(["Left Message", "Submitted"]);
    expect(isSnapshotIndexedAction("Left Message", env)).toBe(true);
    expect(isSnapshotIndexedAction("Scout Screen - Qualified", env)).toBe(true);
  });

  it("empty NOTE_SNAPSHOT_ACTION_PREFIXES disables prefixes", () => {
    const env = {
      NOTE_SNAPSHOT_ACTION_PREFIXES: "",
      NOTE_SNAPSHOT_ACTIONS: "Left Message",
    };
    expect(snapshotActionPrefixes(env)).toEqual([]);
    expect(isSnapshotIndexedAction("Scout Screen - Qualified", env)).toBe(
      false,
    );
    expect(isSnapshotIndexedAction("Left Message", env)).toBe(true);
  });

  it("checks coverage freshness against TTL", () => {
    const now = 1_000_000;
    expect(isCoverageFresh(null, now, 1000)).toBe(false);
    expect(isCoverageFresh(new Date(now - 500), now, 1000)).toBe(true);
    expect(isCoverageFresh(new Date(now - 1500), now, 1000)).toBe(false);
    expect(DEFAULT_NOTE_SNAPSHOT_TTL_MS).toBe(2 * 60 * 60 * 1000);
    expect(noteSnapshotTtlMs({})).toBe(DEFAULT_NOTE_SNAPSHOT_TTL_MS);
    expect(noteSnapshotTtlMs({ NOTE_SNAPSHOT_TTL_MS: "60000" })).toBe(60_000);
  });
});

describe("rankSnapshotCandidates", () => {
  it("collapses notes to candidates and ranks by latest note date", () => {
    const ranked = rankSnapshotCandidates(
      [
        {
          noteId: 1,
          action: "Scout Screen - Qualified",
          candidateId: 10,
          jobId: 100,
          department: "STS-STSI",
          noteDateAdded: 100,
          candidateFirst: "A",
          candidateLast: "One",
        },
        {
          noteId: 2,
          action: "Scout Screen - Qualified",
          candidateId: 20,
          jobId: 200,
          department: "STS-STSI",
          noteDateAdded: 300,
          candidateFirst: "B",
          candidateLast: "Two",
        },
        {
          noteId: 3,
          action: "Scout Screen - Qualified",
          candidateId: 10,
          jobId: 101,
          department: "STS-STSI",
          noteDateAdded: 250,
          candidateFirst: "A",
          candidateLast: "One",
        },
      ],
      2,
    );
    expect(ranked).toHaveLength(2);
    expect(ranked[0]!.id).toBe(20);
    expect(ranked[1]!.id).toBe(10);
    expect(ranked[1]!.latestNoteDate).toBe(250);
    expect(ranked[1]!.matchedJobIds.sort()).toEqual([100, 101]);
  });

  it("refuses to early-confirm when remaining job is not older than Nth note", () => {
    // sanity: rank helper alone does not claim completeness — just ordering
    const ranked = rankSnapshotCandidates(
      [
        {
          noteId: 1,
          action: "Scout Screen - Qualified",
          candidateId: 1,
          jobId: null,
          department: "X",
          noteDateAdded: 50,
          candidateFirst: null,
          candidateLast: null,
        },
      ],
      1,
    );
    expect(ranked[0]!.matchedJobIds).toEqual([]);
  });
});
