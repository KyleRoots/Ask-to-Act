/**
 * Department-parameterized Scout Screen workflow.
 *
 * Bullhorn cannot globally search Notes on this instance (Lucene /search/Note
 * returns 0; /query/Note is rejected). ScoutGenius writes "Scout Screen - *"
 * notes on candidates who applied (Response bucket) to jobs. This tool works
 * around the Note-index gap by:
 *   1. Finding jobs for an Internal Department (correlatedCustomText1)
 *   2. Collecting inbound applicants (and optionally all JobSubmission rows)
 *   3. Reading each candidate's notes via association and keeping those whose
 *      action matches and that reference a scanned department job
 *      (jobOrder id or "Job ID: N" in comments)
 *
 * Department is a free-string parameter (STS-STSI, MYT-Ottawa, …) — not hardcoded.
 *
 * Modes:
 *   - bounded (default): one capped pass; incomplete → LOWER BOUND; clients must
 *     NOT fan out date-window calls (that multiplies get_notes cost / timeouts).
 *   - exhaustive: server partitions JobSubmission dateAdded into windows in ONE
 *     call, dedupes candidates, pages more jobs. Still may be incomplete if
 *     window/job caps are hit.
 */
import { z } from "zod";
import {
  searchJobs,
  searchAnyEntity,
  getNotes,
  noteReferencesJob,
  parseJobIdsFromNoteComments,
} from "./bullhorn-client.js";
import { classifySubmissionStage } from "./submission-status.js";

/** Shared query/body shape for REST + MCP scout report entry points. */
export const scoutReportQuerySchema = z.object({
  department: z.string().min(1),
  noteAction: z.string().min(1).optional(),
  openJobsOnly: z.coerce.boolean().optional(),
  applicantPool: z.enum(["responses", "all"]).optional(),
  mode: z.enum(["bounded", "exhaustive"]).optional(),
  maxJobs: z.coerce.number().int().min(1).max(300).optional(),
  maxCandidatesToScan: z.coerce.number().int().min(1).max(400).optional(),
  dateAddedStart: z.string().optional(),
  dateAddedEnd: z.string().optional(),
});

const DEFAULT_NOTE_ACTION = "Scout Screen - Qualified";
const DEFAULT_MAX_JOBS = 25;
const HARD_MAX_JOBS_BOUNDED = 100;
const HARD_MAX_JOBS_EXHAUSTIVE = 300;
const DEFAULT_MAX_CANDIDATES = 100;
const HARD_MAX_CANDIDATES = 400;
const JOB_ID_BATCH = 20;
const NOTE_SCAN_CONCURRENCY = 8;
const SUBMISSION_PAGE = 50;
const EXHAUSTIVE_DEFAULT_LOOKBACK_DAYS = 90;
const EXHAUSTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const EXHAUSTIVE_MAX_WINDOWS = 16;
const EXHAUSTIVE_PER_WINDOW_CANDIDATES = 400;

const INCOMPLETE_NO_FANOUT =
  "uniqueCandidateCount is a LOWER BOUND for this single call. Report it and STOP. " +
  "Do NOT issue multiple scout_dept_report calls with different dateAddedStart/dateAddedEnd " +
  "to chase an exact total — that multiplies per-candidate note fetches and causes timeouts. " +
  "For a fuller single-call scan, pass mode=exhaustive (server partitions dates internally). " +
  "Or narrow the ask (recent window / one department) and keep mode=bounded.";

function escapeLucenePhrase(term: string): string {
  return term.replace(/[\\"]/g, "\\$&");
}

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) || 1 },
    async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Builds the Lucene JobOrder query for a department. Exported for unit tests. */
export function buildDepartmentJobsQuery(
  department: string,
  openJobsOnly: boolean,
): string {
  const dept = department.trim();
  if (!dept) throw new Error("department is required (e.g. \"STS-STSI\" or \"MYT-Ottawa\").");
  const deptClause = `correlatedCustomText1:"${escapeLucenePhrase(dept)}"`;
  if (openJobsOnly) {
    // Matches the locked open-jobs metric (count_entity / open_jobs_report).
    return `${deptClause} AND isOpen:true AND NOT status:Archive AND isDeleted:false`;
  }
  return `${deptClause} AND isDeleted:false`;
}

/** Parse YYYY-MM-DD or ISO into epoch ms. Exported for tests. */
export function parseScoutDateBound(raw: string, endOfDayExclusive: boolean): number {
  const trimmed = raw.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T00:00:00.000Z`
    : trimmed;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`Invalid date "${raw}"`);
  // dateAddedEnd is exclusive at day start; callers that want inclusive end-of-day
  // pass the next calendar day. Keep parse simple here.
  void endOfDayExclusive;
  return ms;
}

/** Non-overlapping [start, end) windows in UTC ms. Exported for tests. */
export function planExhaustiveDateWindows(
  rangeStartMs: number,
  rangeEndMs: number,
  windowMs: number = EXHAUSTIVE_WINDOW_MS,
  maxWindows: number = EXHAUSTIVE_MAX_WINDOWS,
): Array<{ startMs: number; endMs: number }> {
  if (!(rangeEndMs > rangeStartMs)) {
    throw new Error("exhaustive date range must have end after start");
  }
  const span = rangeEndMs - rangeStartMs;
  let step = windowMs;
  // Stretch windows so we never exceed maxWindows.
  const needed = Math.ceil(span / step);
  if (needed > maxWindows) {
    step = Math.ceil(span / maxWindows);
  }
  const windows: Array<{ startMs: number; endMs: number }> = [];
  for (let start = rangeStartMs; start < rangeEndMs; start += step) {
    windows.push({ startMs: start, endMs: Math.min(start + step, rangeEndMs) });
    if (windows.length >= maxWindows) break;
  }
  return windows;
}

/** Guidance text when caps truncate a scan. Exported for tests. */
export function incompleteGuidanceNote(mode: "bounded" | "exhaustive"): string {
  if (mode === "exhaustive") {
    return (
      "Result may still be incomplete after server-side date partitioning (job and/or " +
      "per-window applicant caps). uniqueCandidateCount is a LOWER BOUND. " +
      INCOMPLETE_NO_FANOUT
    );
  }
  return (
    "Result set may be incomplete because job and/or applicant caps were hit. " +
    INCOMPLETE_NO_FANOUT
  );
}

function candidateIdFromRow(row: Record<string, unknown>): number | null {
  const c = row.candidate;
  if (typeof c === "number" && c > 0) return c;
  if (c && typeof c === "object" && !Array.isArray(c)) {
    const id = (c as { id?: unknown }).id;
    if (typeof id === "number" && id > 0) return id;
  }
  return null;
}

function jobIdFromRow(row: Record<string, unknown>): number | null {
  const j = row.jobOrder;
  if (typeof j === "number" && j > 0) return j;
  if (j && typeof j === "object" && !Array.isArray(j)) {
    const id = (j as { id?: unknown }).id;
    if (typeof id === "number" && id > 0) return id;
  }
  return null;
}

function personName(ref: unknown): { firstName?: string; lastName?: string } {
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return {};
  const r = ref as Record<string, unknown>;
  return {
    ...(typeof r.firstName === "string" ? { firstName: r.firstName } : {}),
    ...(typeof r.lastName === "string" ? { lastName: r.lastName } : {}),
  };
}

export type ScoutApplicantPool = "responses" | "all";
export type ScoutReportMode = "bounded" | "exhaustive";

type MatchNote = {
  noteId: number;
  action: string;
  matchedJobIds: number[];
  dateAdded?: number;
};
type MatchCandidate = {
  id: number;
  firstName?: string;
  lastName?: string;
  bullhornUrl?: string;
  matchedJobIds: number[];
  matchedJobs: Array<{ id: number; title?: string }>;
  notes: MatchNote[];
};

type ScanPassResult = {
  matches: MatchCandidate[];
  jobRows: Array<Record<string, unknown>>;
  jobsTotal: number;
  jobsTruncated: boolean;
  jobIds: number[];
  applicantsUnique: number;
  submissionRowsSeen: number;
  applicantsTruncated: boolean;
  maxJobs: number;
  maxCandidatesToScan: number;
};

async function loadDepartmentJobs(args: {
  department: string;
  openJobsOnly: boolean;
  maxJobs: number;
  pageAll: boolean;
}): Promise<{
  jobRows: Array<Record<string, unknown>>;
  jobsTotal: number;
  jobsTruncated: boolean;
  jobIds: number[];
  jobTitleById: Map<number, string>;
}> {
  const jobsQuery = buildDepartmentJobsQuery(args.department, args.openJobsOnly);
  const jobRows: Array<Record<string, unknown>> = [];
  let jobsTotal = 0;
  let start = 0;
  const pageSize = Math.min(args.maxJobs, 100);

  for (;;) {
    const remaining = args.maxJobs - jobRows.length;
    if (remaining <= 0) break;
    const count = Math.min(pageSize, remaining);
    const jobsRes = (await searchJobs({
      query: jobsQuery,
      fields: "id,title,status,isOpen,correlatedCustomText1,dateAdded",
      count,
      start,
    })) as {
      total?: number;
      data?: Array<Record<string, unknown>>;
    };
    const page = Array.isArray(jobsRes.data) ? jobsRes.data : [];
    if (typeof jobsRes.total === "number") jobsTotal = jobsRes.total;
    jobRows.push(...page);
    start += page.length;
    if (page.length === 0) break;
    if (!args.pageAll) break;
    if (typeof jobsRes.total === "number" && start >= jobsRes.total) break;
    if (page.length < count) break;
  }

  if (jobsTotal === 0) jobsTotal = jobRows.length;
  const jobsTruncated = jobsTotal > jobRows.length;
  const jobIds = jobRows
    .map((r) => (typeof r.id === "number" ? r.id : null))
    .filter((id): id is number => id !== null);
  const jobTitleById = new Map<number, string>();
  for (const r of jobRows) {
    if (typeof r.id === "number" && typeof r.title === "string") {
      jobTitleById.set(r.id, r.title);
    }
  }
  return { jobRows, jobsTotal, jobsTruncated, jobIds, jobTitleById };
}

async function runScoutScanPass(args: {
  department: string;
  noteAction: string;
  openJobsOnly: boolean;
  applicantPool: ScoutApplicantPool;
  maxJobs: number;
  maxCandidatesToScan: number;
  pageAllJobs: boolean;
  dateAddedStartMs?: number;
  dateAddedEndMs?: number;
}): Promise<ScanPassResult> {
  const { jobRows, jobsTotal, jobsTruncated, jobIds, jobTitleById } =
    await loadDepartmentJobs({
      department: args.department,
      openJobsOnly: args.openJobsOnly,
      maxJobs: args.maxJobs,
      pageAll: args.pageAllJobs,
    });

  if (jobIds.length === 0) {
    return {
      matches: [],
      jobRows,
      jobsTotal,
      jobsTruncated: false,
      jobIds,
      applicantsUnique: 0,
      submissionRowsSeen: 0,
      applicantsTruncated: false,
      maxJobs: args.maxJobs,
      maxCandidatesToScan: args.maxCandidatesToScan,
    };
  }

  type ApplicantHit = {
    candidateId: number;
    firstName?: string;
    lastName?: string;
    appliedJobIds: Set<number>;
  };
  const applicants = new Map<number, ApplicantHit>();
  let applicantsTruncated = false;
  let submissionRowsSeen = 0;

  const statusClause =
    args.applicantPool === "responses"
      ? ` AND (status:"New Lead" OR status:"Online Applicant")`
      : "";
  let dateClause = "";
  if (args.dateAddedStartMs !== undefined || args.dateAddedEndMs !== undefined) {
    const lo =
      args.dateAddedStartMs !== undefined ? String(args.dateAddedStartMs) : "*";
    const hi =
      args.dateAddedEndMs !== undefined
        ? String(args.dateAddedEndMs - 1)
        : "*";
    dateClause = ` AND dateAdded:[${lo} TO ${hi}]`;
  }

  const jobIdSet = new Set(jobIds);

  for (const batch of chunk(jobIds, JOB_ID_BATCH)) {
    if (applicants.size >= args.maxCandidatesToScan) {
      applicantsTruncated = true;
      break;
    }
    const idClause = batch.join(" OR ");
    let start = 0;
    for (;;) {
      if (applicants.size >= args.maxCandidatesToScan) {
        applicantsTruncated = true;
        break;
      }
      const page = (await searchAnyEntity({
        entityType: "JobSubmission",
        query: `jobOrder.id:(${idClause})${statusClause}${dateClause}`,
        fields: "id,status,candidate,jobOrder,dateAdded",
        count: SUBMISSION_PAGE,
        start,
      })) as {
        total?: number;
        data?: Array<Record<string, unknown>>;
      };
      const rows = Array.isArray(page.data) ? page.data : [];
      if (rows.length === 0) break;
      submissionRowsSeen += rows.length;
      for (const row of rows) {
        const status = typeof row.status === "string" ? row.status : undefined;
        if (
          args.applicantPool === "responses" &&
          classifySubmissionStage(status) !== "response"
        ) {
          continue;
        }
        const candId = candidateIdFromRow(row);
        const jid = jobIdFromRow(row);
        if (candId === null) continue;
        const existing = applicants.get(candId);
        const names = personName(row.candidate);
        if (!existing) {
          if (applicants.size >= args.maxCandidatesToScan) {
            applicantsTruncated = true;
            break;
          }
          applicants.set(candId, {
            candidateId: candId,
            ...names,
            appliedJobIds: new Set(jid !== null ? [jid] : []),
          });
        } else if (jid !== null) {
          existing.appliedJobIds.add(jid);
        }
      }
      if (applicantsTruncated) break;
      const total = typeof page.total === "number" ? page.total : undefined;
      start += rows.length;
      if (rows.length < SUBMISSION_PAGE) break;
      if (total !== undefined && start >= total) break;
      if (start >= 500) {
        applicantsTruncated = true;
        break;
      }
    }
  }

  const applicantList = [...applicants.values()];
  const jobIdsArr = [...jobIdSet];
  const matches: MatchCandidate[] = [];

  await mapWithLimit(applicantList, NOTE_SCAN_CONCURRENCY, async (app) => {
    const notesRes = (await getNotes({
      candidateId: app.candidateId,
      count: 50,
      start: 0,
      fields:
        "id,action,comments,jobOrder,dateAdded,personReference,candidates",
    })) as { data?: Array<Record<string, unknown>> };
    const notes = Array.isArray(notesRes.data) ? notesRes.data : [];
    const matchedNotes: MatchNote[] = [];
    const matchedJobIds = new Set<number>();

    for (const note of notes) {
      const action = typeof note.action === "string" ? note.action : "";
      if (action !== args.noteAction) continue;
      const hitJobs = jobIdsArr.filter((jid) => noteReferencesJob(note, jid));
      if (hitJobs.length === 0) continue;
      for (const jid of hitJobs) matchedJobIds.add(jid);
      matchedNotes.push({
        noteId: typeof note.id === "number" ? note.id : 0,
        action,
        matchedJobIds: hitJobs,
        ...(typeof note.dateAdded === "number"
          ? { dateAdded: note.dateAdded }
          : {}),
      });
    }

    if (matchedNotes.length === 0) return;

    const fromNote =
      personName(notes[0]?.personReference) || personName(notes[0]?.candidates);
    matches.push({
      id: app.candidateId,
      firstName: app.firstName ?? fromNote.firstName,
      lastName: app.lastName ?? fromNote.lastName,
      matchedJobIds: [...matchedJobIds],
      matchedJobs: [...matchedJobIds].map((id) => ({
        id,
        ...(jobTitleById.has(id) ? { title: jobTitleById.get(id) } : {}),
      })),
      notes: matchedNotes,
    });
  });

  matches.sort((a, b) => a.id - b.id);

  if (matches.length > 0) {
    const idOr = matches.map((m) => m.id).slice(0, 50).join(" OR ");
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

  return {
    matches,
    jobRows,
    jobsTotal,
    jobsTruncated,
    jobIds,
    applicantsUnique: applicantList.length,
    submissionRowsSeen,
    applicantsTruncated,
    maxJobs: args.maxJobs,
    maxCandidatesToScan: args.maxCandidatesToScan,
  };
}

function mergeMatches(
  into: Map<number, MatchCandidate>,
  from: MatchCandidate[],
): void {
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
    if (!existing.firstName && m.firstName) existing.firstName = m.firstName;
    if (!existing.lastName && m.lastName) existing.lastName = m.lastName;
    if (!existing.bullhornUrl && m.bullhornUrl) {
      existing.bullhornUrl = m.bullhornUrl;
    }
  }
}

function emptyNoJobsResult(args: {
  department: string;
  noteAction: string;
  openJobsOnly: boolean;
  applicantPool: ScoutApplicantPool;
  mode: ScoutReportMode;
  maxJobs: number;
  maxCandidatesToScan: number;
  jobsTotal: number;
}): unknown {
  return {
    department: args.department,
    noteAction: args.noteAction,
    openJobsOnly: args.openJobsOnly,
    applicantPool: args.applicantPool,
    mode: args.mode,
    uniqueCandidateCount: 0,
    candidates: [],
    jobsScanned: { count: 0, totalMatching: args.jobsTotal, truncated: false },
    applicantsScanned: { uniqueCandidates: 0, truncated: false },
    limits: { maxJobs: args.maxJobs, maxCandidatesToScan: args.maxCandidatesToScan },
    definition:
      "Jobs by Internal Department (correlatedCustomText1) → inbound applicants " +
      "(JobSubmission Response bucket by default) → candidate notes with matching action " +
      "that reference a scanned job (jobOrder or comment Job ID).",
    note: `No jobs found for department "${args.department}" with the current filters.`,
  };
}

export async function scoutQualifiedByDepartment(args: {
  department: string;
  noteAction?: string;
  openJobsOnly?: boolean;
  /** Default "responses" = Bullhorn Response tab (New Lead / Online Applicant). */
  applicantPool?: ScoutApplicantPool;
  /** Default "bounded". Use "exhaustive" for one-call server-side date partitioning. */
  mode?: ScoutReportMode;
  maxJobs?: number;
  maxCandidatesToScan?: number;
  dateAddedStart?: string;
  dateAddedEnd?: string;
}): Promise<unknown> {
  const department = args.department.trim();
  const noteAction = (args.noteAction ?? DEFAULT_NOTE_ACTION).trim();
  if (!noteAction) throw new Error("noteAction must be a non-empty string.");
  const openJobsOnly = args.openJobsOnly !== false;
  const applicantPool: ScoutApplicantPool =
    args.applicantPool === "all" ? "all" : "responses";
  const mode: ScoutReportMode =
    args.mode === "exhaustive" ? "exhaustive" : "bounded";

  const hardMaxJobs =
    mode === "exhaustive" ? HARD_MAX_JOBS_EXHAUSTIVE : HARD_MAX_JOBS_BOUNDED;
  const defaultMaxJobs =
    mode === "exhaustive" ? HARD_MAX_JOBS_EXHAUSTIVE : DEFAULT_MAX_JOBS;
  const maxJobs = Math.min(
    Math.max(args.maxJobs ?? defaultMaxJobs, 1),
    hardMaxJobs,
  );
  const maxCandidatesToScan = Math.min(
    Math.max(
      args.maxCandidatesToScan ??
        (mode === "exhaustive"
          ? EXHAUSTIVE_PER_WINDOW_CANDIDATES
          : DEFAULT_MAX_CANDIDATES),
      1,
    ),
    HARD_MAX_CANDIDATES,
  );

  let dateStartMs: number | undefined;
  let dateEndMs: number | undefined;
  if (args.dateAddedStart) {
    dateStartMs = parseScoutDateBound(args.dateAddedStart, false);
  }
  if (args.dateAddedEnd) {
    dateEndMs = parseScoutDateBound(args.dateAddedEnd, true);
  }

  if (mode === "bounded") {
    const pass = await runScoutScanPass({
      department,
      noteAction,
      openJobsOnly,
      applicantPool,
      maxJobs,
      maxCandidatesToScan,
      pageAllJobs: false,
      dateAddedStartMs: dateStartMs,
      dateAddedEndMs: dateEndMs,
    });

    if (pass.jobIds.length === 0) {
      return emptyNoJobsResult({
        department,
        noteAction,
        openJobsOnly,
        applicantPool,
        mode,
        maxJobs,
        maxCandidatesToScan,
        jobsTotal: pass.jobsTotal,
      });
    }

    const incomplete = pass.jobsTruncated || pass.applicantsTruncated;
    return {
      department,
      noteAction,
      openJobsOnly,
      applicantPool,
      mode,
      uniqueCandidateCount: pass.matches.length,
      candidates: pass.matches,
      jobsScanned: {
        count: pass.jobIds.length,
        totalMatching: pass.jobsTotal,
        truncated: pass.jobsTruncated,
        jobs: pass.jobRows.map((r) => ({
          id: r.id,
          title: r.title,
          status: r.status,
          isOpen: r.isOpen,
        })),
      },
      applicantsScanned: {
        uniqueCandidates: pass.applicantsUnique,
        submissionRowsSeen: pass.submissionRowsSeen,
        truncated: pass.applicantsTruncated,
      },
      limits: { maxJobs, maxCandidatesToScan },
      definition:
        "1) JobOrder Internal Department = correlatedCustomText1 (exact). " +
        "2) Applicant pool = JobSubmission Response statuses (New Lead / Online Applicant) by default — not recruiter submissions. " +
        `3) Notes loaded per candidate; keep action exactly "${noteAction}" that reference a scanned job via jobOrder or comment "Job ID: N". ` +
        "4) Return UNIQUE candidates. Global Note Lucene search is unavailable on this instance. " +
        "5) mode=bounded is a single capped pass — incomplete means LOWER BOUND, do not fan out date windows.",
      ...(incomplete
        ? { incomplete: true, note: incompleteGuidanceNote("bounded") }
        : {
            note:
              "Unique candidates among the scanned applicant pool for this department. " +
              "Not a firm-wide Note Lucene count (Note search index returns 0 on this Bullhorn instance).",
          }),
    };
  }

  // --- exhaustive: one call, server-side date windows + more jobs ---
  const now = Date.now();
  const rangeEnd = dateEndMs ?? now;
  const rangeStart =
    dateStartMs ??
    rangeEnd - EXHAUSTIVE_DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  if (!(rangeEnd > rangeStart)) {
    throw new Error("dateAddedEnd must be after dateAddedStart");
  }
  const windows = planExhaustiveDateWindows(rangeStart, rangeEnd);

  const merged = new Map<number, MatchCandidate>();
  let jobsTruncated = false;
  let applicantsTruncated = false;
  let jobsTotal = 0;
  let jobRows: Array<Record<string, unknown>> = [];
  let jobIds: number[] = [];
  let submissionRowsSeen = 0;
  let applicantsUniqueAcrossWindows = 0;
  const windowSummaries: Array<{
    dateAddedStart: string;
    dateAddedEnd: string;
    uniqueCandidatesMatched: number;
    applicantsScanned: number;
    truncated: boolean;
  }> = [];

  for (const w of windows) {
    const pass = await runScoutScanPass({
      department,
      noteAction,
      openJobsOnly,
      applicantPool,
      maxJobs,
      maxCandidatesToScan,
      pageAllJobs: true,
      dateAddedStartMs: w.startMs,
      dateAddedEndMs: w.endMs,
    });
    jobsTotal = pass.jobsTotal;
    jobRows = pass.jobRows;
    jobIds = pass.jobIds;
    if (pass.jobsTruncated) jobsTruncated = true;
    if (pass.applicantsTruncated) applicantsTruncated = true;
    submissionRowsSeen += pass.submissionRowsSeen;
    applicantsUniqueAcrossWindows += pass.applicantsUnique;
    mergeMatches(merged, pass.matches);
    windowSummaries.push({
      dateAddedStart: new Date(w.startMs).toISOString().slice(0, 10),
      dateAddedEnd: new Date(w.endMs).toISOString().slice(0, 10),
      uniqueCandidatesMatched: pass.matches.length,
      applicantsScanned: pass.applicantsUnique,
      truncated: pass.applicantsTruncated || pass.jobsTruncated,
    });
  }

  if (jobIds.length === 0) {
    return emptyNoJobsResult({
      department,
      noteAction,
      openJobsOnly,
      applicantPool,
      mode,
      maxJobs,
      maxCandidatesToScan,
      jobsTotal,
    });
  }

  const matches = [...merged.values()].sort((a, b) => a.id - b.id);
  const incomplete = jobsTruncated || applicantsTruncated;

  return {
    department,
    noteAction,
    openJobsOnly,
    applicantPool,
    mode,
    uniqueCandidateCount: matches.length,
    candidates: matches,
    jobsScanned: {
      count: jobIds.length,
      totalMatching: jobsTotal,
      truncated: jobsTruncated,
      jobs: jobRows.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        isOpen: r.isOpen,
      })),
    },
    applicantsScanned: {
      uniqueCandidates: applicantsUniqueAcrossWindows,
      submissionRowsSeen,
      truncated: applicantsTruncated,
      windows: windowSummaries.length,
    },
    exhaustive: {
      dateAddedStart: new Date(rangeStart).toISOString().slice(0, 10),
      dateAddedEnd: new Date(rangeEnd).toISOString().slice(0, 10),
      windowCount: windows.length,
      windows: windowSummaries,
    },
    limits: { maxJobs, maxCandidatesToScan, maxWindows: EXHAUSTIVE_MAX_WINDOWS },
    definition:
      "mode=exhaustive: same Scout Screen filters as bounded, but the server partitions " +
      "JobSubmission dateAdded into non-overlapping windows in ONE call and dedupes candidates. " +
      "Default lookback is 90 days when dates are omitted. Still not a firm-wide Note Lucene count.",
    ...(incomplete
      ? { incomplete: true, note: incompleteGuidanceNote("exhaustive") }
      : {
          note:
            "Exhaustive single-call scan completed without per-window applicant/job truncation " +
            "within the date range shown in exhaustive.*. Still not a global Note Lucene total.",
        }),
  };
}

/** Re-export for tests that assert comment parsing stays wired. */
export { parseJobIdsFromNoteComments, noteReferencesJob };
