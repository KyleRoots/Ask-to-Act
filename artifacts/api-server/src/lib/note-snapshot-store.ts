import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import {
  db,
  noteActionSnapshotTable,
  noteSnapshotCoverageTable,
} from "@workspace/db";
import {
  isCoverageFresh,
  noteSnapshotTtlMs,
} from "./note-snapshot-allowlist.js";
import type { SnapshotNoteHit } from "./scout-screen.js";

export type CoverageStatus = "complete" | "partial" | "failed";
export type ApplicantPoolSynced = "all" | "responses";

export async function upsertSnapshotNotes(
  firmId: string,
  rows: SnapshotNoteHit[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const now = new Date();
  let upserted = 0;
  const chunkSize = 100;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    await db
      .insert(noteActionSnapshotTable)
      .values(
        slice.map((r) => ({
          firmId,
          noteId: r.noteId,
          action: r.action,
          candidateId: r.candidateId,
          jobId: r.jobId,
          department: r.department,
          noteDateAdded: r.noteDateAdded,
          candidateFirst: r.candidateFirst ?? null,
          candidateLast: r.candidateLast ?? null,
          responseApplicant: r.responseApplicant,
          syncedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [
          noteActionSnapshotTable.firmId,
          noteActionSnapshotTable.noteId,
        ],
        set: {
          action: sql`excluded.action`,
          candidateId: sql`excluded.candidate_id`,
          jobId: sql`excluded.job_id`,
          department: sql`excluded.department`,
          noteDateAdded: sql`excluded.note_date_added`,
          candidateFirst: sql`excluded.candidate_first`,
          candidateLast: sql`excluded.candidate_last`,
          responseApplicant: sql`excluded.response_applicant`,
          syncedAt: sql`excluded.synced_at`,
        },
      });
    upserted += slice.length;
  }
  return upserted;
}

export async function writeCoverage(args: {
  firmId: string;
  department: string;
  status: CoverageStatus;
  notesUpserted: number;
  applicantPoolSynced?: ApplicantPoolSynced;
  errorSummary?: string;
}): Promise<void> {
  const now = new Date();
  const applicantPoolSynced = args.applicantPoolSynced ?? "all";
  await db
    .insert(noteSnapshotCoverageTable)
    .values({
      firmId: args.firmId,
      department: args.department,
      status: args.status,
      lastAttemptAt: now,
      lastFullSyncAt: args.status === "complete" ? now : null,
      notesUpserted: args.notesUpserted,
      errorSummary: args.errorSummary?.slice(0, 500) ?? null,
      applicantPoolSynced,
    })
    .onConflictDoUpdate({
      target: [
        noteSnapshotCoverageTable.firmId,
        noteSnapshotCoverageTable.department,
      ],
      set: {
        status: args.status,
        lastAttemptAt: now,
        notesUpserted: args.notesUpserted,
        errorSummary: args.errorSummary?.slice(0, 500) ?? null,
        applicantPoolSynced,
        ...(args.status === "complete"
          ? { lastFullSyncAt: now }
          : {}),
      },
    });
}

export async function getCoverage(
  firmId: string,
  department: string,
): Promise<typeof noteSnapshotCoverageTable.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(noteSnapshotCoverageTable)
    .where(
      and(
        eq(noteSnapshotCoverageTable.firmId, firmId),
        eq(noteSnapshotCoverageTable.department, department),
      ),
    )
    .limit(1);
  return row ?? null;
}

export function coverageIsServable(
  coverage: typeof noteSnapshotCoverageTable.$inferSelect | null,
  nowMs: number = Date.now(),
): boolean {
  if (!coverage) return false;
  if (coverage.status !== "complete") return false;
  return isCoverageFresh(coverage.lastFullSyncAt, nowMs, noteSnapshotTtlMs());
}

/**
 * Whether snapshot coverage can answer the requested applicant pool.
 * `all` requires applicant_pool_synced=all; `responses` works for either
 * (all-pool syncs tag response_applicant for filtering).
 */
export function coverageServesApplicantPool(
  coverage: typeof noteSnapshotCoverageTable.$inferSelect | null,
  applicantPool: "responses" | "all",
  nowMs: number = Date.now(),
): boolean {
  if (!coverageIsServable(coverage, nowMs)) return false;
  if (applicantPool === "all") {
    return coverage!.applicantPoolSynced === "all";
  }
  return true;
}

export type SnapshotQueryRow = {
  noteId: number;
  action: string;
  candidateId: number;
  jobId: number | null;
  department: string | null;
  noteDateAdded: number;
  candidateFirst: string | null;
  candidateLast: string | null;
  responseApplicant: boolean;
};

export async function querySnapshotNotes(args: {
  firmId: string;
  department: string;
  noteAction: string;
  dateAddedStartMs?: number;
  dateAddedEndMs?: number;
  /** When true, only notes whose candidate had a Response-bucket submission. */
  responseApplicantsOnly?: boolean;
  limit?: number;
}): Promise<SnapshotQueryRow[]> {
  const conditions = [
    eq(noteActionSnapshotTable.firmId, args.firmId),
    eq(noteActionSnapshotTable.department, args.department),
    eq(noteActionSnapshotTable.action, args.noteAction),
  ];
  if (args.responseApplicantsOnly) {
    conditions.push(eq(noteActionSnapshotTable.responseApplicant, true));
  }
  if (args.dateAddedStartMs !== undefined) {
    conditions.push(
      gte(noteActionSnapshotTable.noteDateAdded, args.dateAddedStartMs),
    );
  }
  if (args.dateAddedEndMs !== undefined) {
    conditions.push(
      lt(noteActionSnapshotTable.noteDateAdded, args.dateAddedEndMs),
    );
  }

  const rows = await db
    .select({
      noteId: noteActionSnapshotTable.noteId,
      action: noteActionSnapshotTable.action,
      candidateId: noteActionSnapshotTable.candidateId,
      jobId: noteActionSnapshotTable.jobId,
      department: noteActionSnapshotTable.department,
      noteDateAdded: noteActionSnapshotTable.noteDateAdded,
      candidateFirst: noteActionSnapshotTable.candidateFirst,
      candidateLast: noteActionSnapshotTable.candidateLast,
      responseApplicant: noteActionSnapshotTable.responseApplicant,
    })
    .from(noteActionSnapshotTable)
    .where(and(...conditions))
    .orderBy(desc(noteActionSnapshotTable.noteDateAdded))
    .limit(
      typeof args.limit === "number" && args.limit > 0
        ? Math.min(args.limit * 20, 500)
        : 500,
    );

  return rows;
}

/**
 * Collapse snapshot note rows into unique candidates ranked by latest note date.
 */
export function rankSnapshotCandidates(
  rows: SnapshotQueryRow[],
  limit?: number,
): Array<{
  id: number;
  firstName?: string;
  lastName?: string;
  matchedJobIds: number[];
  matchedJobs: Array<{ id: number; title?: string }>;
  notes: Array<{
    noteId: number;
    action: string;
    matchedJobIds: number[];
    dateAdded?: number;
  }>;
  latestNoteDate: number;
}> {
  const byCandidate = new Map<
    number,
    {
      id: number;
      firstName?: string;
      lastName?: string;
      jobIds: Set<number>;
      notes: Array<{
        noteId: number;
        action: string;
        matchedJobIds: number[];
        dateAdded?: number;
      }>;
      latestNoteDate: number;
    }
  >();

  for (const row of rows) {
    let entry = byCandidate.get(row.candidateId);
    if (!entry) {
      entry = {
        id: row.candidateId,
        ...(row.candidateFirst ? { firstName: row.candidateFirst } : {}),
        ...(row.candidateLast ? { lastName: row.candidateLast } : {}),
        jobIds: new Set<number>(),
        notes: [],
        latestNoteDate: 0,
      };
      byCandidate.set(row.candidateId, entry);
    }
    if (row.jobId != null) entry.jobIds.add(row.jobId);
    entry.notes.push({
      noteId: row.noteId,
      action: row.action,
      matchedJobIds: row.jobId != null ? [row.jobId] : [],
      dateAdded: row.noteDateAdded,
    });
    if (row.noteDateAdded > entry.latestNoteDate) {
      entry.latestNoteDate = row.noteDateAdded;
    }
    if (!entry.firstName && row.candidateFirst) {
      entry.firstName = row.candidateFirst;
    }
    if (!entry.lastName && row.candidateLast) {
      entry.lastName = row.candidateLast;
    }
  }

  const ranked = [...byCandidate.values()]
    .map((e) => ({
      id: e.id,
      ...(e.firstName ? { firstName: e.firstName } : {}),
      ...(e.lastName ? { lastName: e.lastName } : {}),
      matchedJobIds: [...e.jobIds],
      matchedJobs: [...e.jobIds].map((id) => ({ id })),
      notes: e.notes,
      latestNoteDate: e.latestNoteDate,
    }))
    .sort(
      (a, b) => b.latestNoteDate - a.latestNoteDate || a.id - b.id,
    );

  if (typeof limit === "number" && limit > 0) return ranked.slice(0, limit);
  return ranked;
}
