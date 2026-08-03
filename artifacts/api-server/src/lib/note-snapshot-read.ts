import { searchAnyEntity } from "./bullhorn-client.js";
import { currentFirmContextId } from "./bullhorn-auth.js";
import { isSnapshotIndexedAction } from "./note-snapshot-allowlist.js";
import {
  coverageServesApplicantPool,
  getCoverage,
  querySnapshotNotes,
  rankSnapshotCandidates,
} from "./note-snapshot-store.js";
import { liveTailScoutMatches } from "./scout-screen.js";

type ScoutMatch = {
  id: number;
  firstName?: string;
  lastName?: string;
  bullhornUrl?: string;
  matchedJobIds: number[];
  matchedJobs: Array<{ id: number; title?: string }>;
  notes: Array<{
    noteId: number;
    action: string;
    matchedJobIds: number[];
    dateAdded?: number;
  }>;
  latestNoteDate?: number;
};

function mergeMatches(into: Map<number, ScoutMatch>, from: ScoutMatch[]): void {
  for (const m of from) {
    const existing = into.get(m.id);
    if (!existing) {
      into.set(m.id, {
        ...m,
        matchedJobIds: [...m.matchedJobIds],
        matchedJobs: [...m.matchedJobs],
        notes: [...m.notes],
      });
      continue;
    }
    const jobIds = new Set([...existing.matchedJobIds, ...m.matchedJobIds]);
    existing.matchedJobIds = [...jobIds];
    const jobById = new Map(existing.matchedJobs.map((j) => [j.id, j]));
    for (const j of m.matchedJobs) jobById.set(j.id, j);
    existing.matchedJobs = [...jobById.values()];
    const noteIds = new Set(existing.notes.map((n) => n.noteId));
    for (const n of m.notes) {
      if (!noteIds.has(n.noteId)) existing.notes.push(n);
    }
    const latest = Math.max(
      existing.latestNoteDate ?? 0,
      m.latestNoteDate ?? 0,
      ...m.notes.map((n) => n.dateAdded ?? 0),
    );
    if (latest > 0) existing.latestNoteDate = latest;
    if (!existing.firstName && m.firstName) existing.firstName = m.firstName;
    if (!existing.lastName && m.lastName) existing.lastName = m.lastName;
    if (!existing.bullhornUrl && m.bullhornUrl) {
      existing.bullhornUrl = m.bullhornUrl;
    }
  }
}

function rankLimit(matches: ScoutMatch[], limit?: number): ScoutMatch[] {
  const ranked = [...matches].sort(
    (a, b) =>
      (b.latestNoteDate ?? 0) - (a.latestNoteDate ?? 0) || a.id - b.id,
  );
  if (typeof limit === "number" && limit > 0) return ranked.slice(0, limit);
  return ranked;
}

async function enrichBullhornUrls(matches: ScoutMatch[]): Promise<void> {
  if (matches.length === 0) return;
  const idOr = matches
    .map((m) => m.id)
    .slice(0, 50)
    .join(" OR ");
  const enriched = (await searchAnyEntity({
    entityType: "Candidate",
    query: `id:(${idOr})`,
    fields: "id,firstName,lastName",
    count: Math.min(matches.length, 50),
    start: 0,
  })) as { data?: Array<Record<string, unknown>> };
  const byId = new Map<number, Record<string, unknown>>();
  for (const row of Array.isArray(enriched.data) ? enriched.data : []) {
    if (typeof row.id === "number") byId.set(row.id, row);
  }
  for (const m of matches) {
    const row = byId.get(m.id);
    if (row && typeof row.bullhornUrl === "string") {
      m.bullhornUrl = row.bullhornUrl;
    }
    if (!m.firstName && typeof row?.firstName === "string") {
      m.firstName = row.firstName;
    }
    if (!m.lastName && typeof row?.lastName === "string") {
      m.lastName = row.lastName;
    }
  }
}

/**
 * Serve scout_dept_report from Postgres snapshot when coverage is fresh.
 * Returns null to signal caller should use Lucene / live association walk.
 *
 * Serves both applicantPool=responses (filtered via response_applicant) and
 * applicantPool=all when coverage.applicant_pool_synced=all.
 */
export async function tryServeScoutFromSnapshot(args: {
  department: string;
  resolvedFrom?: string;
  noteAction: string;
  openJobsOnly: boolean;
  applicantPool: "responses" | "all";
  mode: "bounded" | "exhaustive";
  limit?: number;
  dateAddedStartMs?: number;
  dateAddedEndMs?: number;
}): Promise<unknown | null> {
  if (args.mode === "exhaustive") return null;
  if (!args.openJobsOnly) return null;
  if (!isSnapshotIndexedAction(args.noteAction)) return null;

  const firmId = currentFirmContextId();
  if (!firmId) return null;

  const coverage = await getCoverage(firmId, args.department);
  if (!coverageServesApplicantPool(coverage, args.applicantPool)) return null;

  const startedAt = Date.now();
  // Legacy responses-only syncs stored only Response applicants without the
  // response_applicant tag (column defaulted false on 0013). Filter by the
  // tag only after an all-pool sync has written it correctly.
  const responseApplicantsOnly =
    args.applicantPool === "responses" &&
    coverage!.applicantPoolSynced === "all";
  const rows = await querySnapshotNotes({
    firmId,
    department: args.department,
    noteAction: args.noteAction,
    dateAddedStartMs: args.dateAddedStartMs,
    dateAddedEndMs: args.dateAddedEndMs,
    responseApplicantsOnly,
    limit: args.limit,
  });
  const fromSnap = rankSnapshotCandidates(rows, undefined);

  const merged = new Map<number, ScoutMatch>();
  mergeMatches(
    merged,
    fromSnap.map((c) => ({
      ...c,
      latestNoteDate: c.latestNoteDate,
    })),
  );

  const tail = await liveTailScoutMatches({
    department: args.department,
    noteAction: args.noteAction,
    applicantPool: args.applicantPool,
  });
  mergeMatches(merged, tail.matches);

  const ranked = rankLimit([...merged.values()], args.limit);
  await enrichBullhornUrls(ranked);

  // Snapshot coverage is complete+fresh when we get here. If the snapshot alone
  // already supplies a full top-N ranking, do not let a live-tail soft wall
  // alone mark confirmedComplete=false (universal correctness for any dept).
  const snapshotSatisfiesTopN =
    typeof args.limit === "number" &&
    args.limit > 0 &&
    fromSnap.length >= args.limit;
  const confirmedComplete =
    !tail.stoppedForWallTime || snapshotSatisfiesTopN;
  const noteScanPath = "snapshot+live_tail";
  const syncedAt = coverage!.lastFullSyncAt?.toISOString() ?? null;

  let userNote: string;
  if (confirmedComplete && args.limit !== undefined) {
    userNote =
      `Top ${ranked.length} most recent matching candidates by Scout/note date ` +
      `from the firm note snapshot (synced ${syncedAt ?? "recently"}) plus a live tail of newest open jobs. ` +
      `confirmedComplete=true.` +
      (snapshotSatisfiesTopN && tail.stoppedForWallTime
        ? " Live tail hit the soft wall, but the snapshot already held a full top-N ranking."
        : "");
  } else if (confirmedComplete) {
    userNote =
      `Unique matching candidates from the firm note snapshot (synced ${syncedAt ?? "recently"}) ` +
      `plus a live tail of newest open jobs. confirmedComplete=true.`;
  } else {
    userNote =
      `Showing ${ranked.length} matching candidate(s) from the note snapshot plus a live tail that hit the ` +
      `gateway soft wall before finishing. Treat as a strong partial; stopReason=wall_time. ` +
      `Do NOT fan out date windows. Soft wall is never a dead end — continue via async job.`;
  }

  return {
    department: args.department,
    ...(args.resolvedFrom
      ? { departmentResolvedFrom: args.resolvedFrom }
      : {}),
    noteAction: args.noteAction,
    openJobsOnly: true,
    applicantPool: args.applicantPool,
    mode: "bounded",
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    uniqueCandidateCount: ranked.length,
    candidates: ranked,
    jobsScanned: {
      count: 0,
      totalMatching: 0,
      truncated: false,
      order: "snapshot",
      liveTailJobs: true,
    },
    applicantsScanned: {
      uniqueCandidates: ranked.length,
      truncated: false,
      fromSnapshot: true,
    },
    autoWiden: {
      elapsedMs: Date.now() - startedAt,
      stoppedForWallTime: tail.stoppedForWallTime,
      snapshotSatisfiesTopN,
      noteScanPath,
      rankedBy: "latestMatchingNoteDate",
      snapshotSyncedAt: syncedAt,
      snapshotCoverageStatus: coverage!.status,
      snapshotApplicantPoolSynced: coverage!.applicantPoolSynced,
    },
    limits: {
      snapshotTtlHonored: true,
    },
    stopReason: confirmedComplete ? "complete" : "wall_time",
    confirmedComplete,
    definition:
      "Served from firm note_action_snapshot (background sync of allowlisted Note.action values " +
      "across all open-job applicants, with response_applicant tags) with a live tail of newest " +
      "open-job applicants. Falls back to live association walk when coverage is missing, stale, " +
      "or filters are outside snapshot scope (closed jobs / exhaustive / pool=all before all-pool sync).",
    ...(confirmedComplete
      ? { note: userNote }
      : { incomplete: true, note: userNote }),
  };
}
