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
 *   - bounded (default): natural-language friendly — resolves department nicknames
 *     (e.g. STSI → STS-STSI), defaults to open jobs, optional `limit` for "most recent N"
 *     (sorted by note date), and auto-pages jobs in ONE call until N found or caps/wall.
 *   - exhaustive: server partitions JobSubmission dateAdded into windows in ONE
 *     call (counts over a lookback). Prefer bounded+limit for "list most recent".
 */
import { z } from "zod";
import {
  searchJobs,
  searchAnyEntity,
  getNotes,
  noteReferencesJob,
  parseJobIdsFromNoteComments,
  countEntity,
  queryJobSubmissions,
} from "./bullhorn-client.js";
import { classifySubmissionStage } from "./submission-status.js";

/** Fallback Internal Department names when live discovery fails (Myticas). */
const DEPARTMENT_FALLBACK = [
  "STS-STSI",
  "MYT-Ottawa",
  "MYT-Chicago",
  "MYT-Clover",
  "MYT-Ohio",
] as const;

/** Shared query/body shape for REST + MCP scout report entry points. */
export const scoutReportQuerySchema = z.object({
  department: z.string().min(1),
  noteAction: z.string().min(1).optional(),
  openJobsOnly: z.coerce.boolean().optional(),
  applicantPool: z.enum(["responses", "all"]).optional(),
  mode: z.enum(["bounded", "exhaustive"]).optional(),
  /** Top-N most recent by matching note dateAdded (natural-language "list 5 most recent"). */
  limit: z.coerce.number().int().min(1).max(50).optional(),
  maxJobs: z.coerce.number().int().min(1).max(2000).optional(),
  maxCandidatesToScan: z.coerce.number().int().min(1).max(800).optional(),
  dateAddedStart: z.string().optional(),
  dateAddedEnd: z.string().optional(),
});

const DEFAULT_NOTE_ACTION = "Scout Screen - Qualified";
const HARD_MAX_JOBS_EXHAUSTIVE = 2000;
const DEFAULT_MAX_JOBS_EXHAUSTIVE = 500;
/** Note-scan budget ceiling (get_notes is the expensive step). */
const HARD_MAX_CANDIDATES = 800;
const JOB_ID_BATCH = 10;
const NOTE_SCAN_CONCURRENCY = 8;
const SUBMISSION_PAGE = 50;
/** Per job-id batch: page JobSubmissions until total or this safety depth. */
const SUBMISSION_PAGE_DEPTH = 5_000;
/** ChatGPT / gateway proxies often 504 around ~120s — keep headroom. */
export const EXHAUSTIVE_DEFAULT_LOOKBACK_DAYS = 30;
const EXHAUSTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const EXHAUSTIVE_MAX_WINDOWS = 6;
const EXHAUSTIVE_PER_WINDOW_CANDIDATES = 500;
/** Soft wall budget for exhaustive / auto-widen scans (ms). */
export const EXHAUSTIVE_WALL_MS = 75_000;
/** Fewer jobs per page → fuller newest-first applicant coverage before the note-scan budget. */
const AUTO_WIDEN_JOB_PAGE = 20;
/**
 * Bounded auto-widen pages until jobs are exhausted or the wall hits.
 * Hard ceiling only as a safety valve (gateway/timeout protection).
 */
const AUTO_WIDEN_MAX_JOBS = 2000;
const AUTO_WIDEN_CANDIDATES_PER_PAGE = 500;

/** Machine-readable why a scout call stopped — caps vs connector vs complete. */
export type ScoutStopReason =
  | "complete"
  | "wall_time"
  | "job_safety_cap"
  | "applicant_cap"
  | "submission_page_depth"
  | "no_matching_jobs";

const INCOMPLETE_NO_FANOUT =
  "Do NOT issue multiple scout_dept_report calls with different dateAddedStart/dateAddedEnd " +
  "to chase an exact total — that multiplies per-candidate note fetches and causes timeouts. " +
  "For a fuller single-call lookback count, ONE follow-up with mode=exhaustive is allowed. " +
  "Or narrow the ask (recent window / one department) and keep mode=bounded.";

const INCOMPLETE_PARTIAL_RESULTS =
  "uniqueCandidateCount is a LOWER BOUND / partial ranked list for this single call. " +
  "Present these results to the user. Do NOT invent more names. " +
  "Check stopReason / confirmedComplete: only stop treating the task as unfinished when " +
  "confirmedComplete is true, or stopReason reflects a true connector/gateway limit you cannot work around. " +
  INCOMPLETE_NO_FANOUT +
  " If filters are ambiguous, ask one clarifying question; otherwise continue with one broader/exhaustive call.";

const INCOMPLETE_ZERO_NOT_CONFIRMED =
  "uniqueCandidateCount is 0 but confirmedComplete is false — " +
  "this is NOT a confirmed zero. Do NOT tell the user there are no matching candidates. " +
  "Say the first pass found none in the scanned portion, then either ask one clarifying question " +
  "(confirm department, include closed jobs, all applicants vs responses) " +
  "and/or call scout_dept_report once more with broader filters or mode=exhaustive. " +
  INCOMPLETE_NO_FANOUT;

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

/**
 * Map a user/AI nickname (e.g. "STSI") to a real Internal Department value.
 * Exported for unit tests.
 */
export function pickDepartmentMatch(
  input: string,
  values: readonly string[],
): string | null {
  const q = input.trim().toLowerCase();
  if (!q) return null;
  const exact = values.find((v) => v.toLowerCase() === q);
  if (exact) return exact;
  const suffix = values.filter((v) => {
    const vl = v.toLowerCase();
    return vl.endsWith(`-${q}`) || vl.endsWith(q);
  });
  if (suffix.length === 1) return suffix[0]!;
  if (suffix.length > 1) {
    return [...suffix].sort((a, b) => a.length - b.length || a.localeCompare(b))[0]!;
  }
  const contains = values.filter((v) => v.toLowerCase().includes(q));
  if (contains.length === 1) return contains[0]!;
  if (contains.length > 1) {
    return [...contains].sort((a, b) => a.length - b.length || a.localeCompare(b))[0]!;
  }
  return null;
}

async function listInternalDepartments(): Promise<string[]> {
  try {
    const r = (await countEntity({
      entityType: "JobOrder",
      query: "isDeleted:false",
      groupBy: "correlatedCustomText1",
    })) as {
      groups?: Array<{ value?: string; count?: number }>;
    };
    const values = (r.groups ?? [])
      .map((g) => g.value)
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    if (values.length > 0) return values;
  } catch {
    // fall through
  }
  return [...DEPARTMENT_FALLBACK];
}

/** Resolve nicknames like STSI → STS-STSI. Exported for tests via pickDepartmentMatch. */
export async function resolveDepartmentLabel(input: string): Promise<{
  department: string;
  resolvedFrom?: string;
}> {
  const raw = input.trim();
  const values = await listInternalDepartments();
  const picked = pickDepartmentMatch(raw, values);
  if (picked && picked !== raw) {
    return { department: picked, resolvedFrom: raw };
  }
  if (picked) return { department: picked };
  // Keep caller string — may still match Lucene exact if discovery was incomplete.
  return { department: raw };
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

export function incompleteGuidanceNote(
  mode: "bounded" | "exhaustive",
  opts?: { stoppedForWallTime?: boolean; matchCount?: number },
): string {
  const wall = opts?.stoppedForWallTime
    ? "Scan stopped early under the ChatGPT/gateway timeout budget (stopReason=wall_time) — a real platform limit, not a search-cap give-up. "
    : "";
  const zeroUnconfirmed =
    typeof opts?.matchCount === "number" && opts.matchCount === 0;

  if (zeroUnconfirmed) {
    return wall + INCOMPLETE_ZERO_NOT_CONFIRMED;
  }

  if (mode === "exhaustive") {
    return (
      wall +
      "Result may still be incomplete after server-side date partitioning (job and/or " +
      "per-window applicant caps, or wall-time budget). " +
      INCOMPLETE_PARTIAL_RESULTS +
      " Prefer an explicit recent dateAddedStart/dateAddedEnd (e.g. last 2–3 weeks) with mode=exhaustive."
    );
  }
  return (
    wall +
    "Result set may be incomplete (jobs/applicants still unscanned, or wall). " +
    INCOMPLETE_PARTIAL_RESULTS
  );
}

/** Prefer the most specific incomplete reason for the model. */
export function resolveScoutStopReason(args: {
  noJobs?: boolean;
  stoppedForWallTime?: boolean;
  jobsTruncated?: boolean;
  applicantsTruncated?: boolean;
  submissionDepthTruncated?: boolean;
}): ScoutStopReason {
  if (args.noJobs) return "no_matching_jobs";
  if (args.stoppedForWallTime) return "wall_time";
  if (args.submissionDepthTruncated) return "submission_page_depth";
  if (args.applicantsTruncated) return "applicant_cap";
  if (args.jobsTruncated) return "job_safety_cap";
  return "complete";
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
  /** Max matching note dateAdded (ms) — used for "most recent" ranking. */
  latestNoteDate?: number;
};

type ApplicantHit = {
  candidateId: number;
  firstName?: string;
  lastName?: string;
  appliedJobIds: Set<number>;
  /** Newest JobSubmission.dateAdded seen for this candidate (ms). */
  latestSubmissionMs: number;
};

/**
 * Keep a bounded applicant set biased toward the newest submissions.
 * When full, newer applicants displace the oldest; older ones are skipped.
 * Returns whether the pool is incomplete relative to the full applicant universe.
 */
export function upsertApplicantPreferRecent(
  map: Map<number, ApplicantHit>,
  hit: ApplicantHit,
  maxSize: number,
): { incomplete: boolean } {
  const existing = map.get(hit.candidateId);
  if (existing) {
    if (hit.latestSubmissionMs > existing.latestSubmissionMs) {
      existing.latestSubmissionMs = hit.latestSubmissionMs;
    }
    for (const jid of hit.appliedJobIds) existing.appliedJobIds.add(jid);
    if (!existing.firstName && hit.firstName) existing.firstName = hit.firstName;
    if (!existing.lastName && hit.lastName) existing.lastName = hit.lastName;
    return { incomplete: false };
  }
  if (map.size < maxSize) {
    map.set(hit.candidateId, hit);
    return { incomplete: false };
  }
  let oldestId: number | null = null;
  let oldestMs = Infinity;
  for (const [id, a] of map) {
    if (a.latestSubmissionMs < oldestMs) {
      oldestMs = a.latestSubmissionMs;
      oldestId = id;
    }
  }
  if (oldestId !== null && hit.latestSubmissionMs > oldestMs) {
    map.delete(oldestId);
    map.set(hit.candidateId, hit);
  }
  // Cap was binding either way — we could not retain every applicant.
  return { incomplete: true };
}

function latestNoteMs(m: MatchCandidate): number {
  if (typeof m.latestNoteDate === "number") return m.latestNoteDate;
  let max = 0;
  for (const n of m.notes) {
    if (typeof n.dateAdded === "number" && n.dateAdded > max) max = n.dateAdded;
  }
  return max;
}

function withLatestNoteDate(m: MatchCandidate): MatchCandidate {
  const latestNoteDate = latestNoteMs(m);
  return latestNoteDate > 0 ? { ...m, latestNoteDate } : { ...m };
}

function rankAndLimitMatches(
  matches: MatchCandidate[],
  limit?: number,
): MatchCandidate[] {
  const ranked = matches
    .map(withLatestNoteDate)
    .sort((a, b) => latestNoteMs(b) - latestNoteMs(a) || a.id - b.id);
  if (typeof limit === "number" && limit > 0) return ranked.slice(0, limit);
  return ranked;
}

type ScanPassResult = {
  matches: MatchCandidate[];
  jobRows: Array<Record<string, unknown>>;
  jobsTotal: number;
  jobsTruncated: boolean;
  jobIds: number[];
  applicantsUnique: number;
  submissionRowsSeen: number;
  applicantsTruncated: boolean;
  submissionDepthTruncated: boolean;
  maxJobs: number;
  maxCandidatesToScan: number;
};

async function loadDepartmentJobs(args: {
  department: string;
  openJobsOnly: boolean;
  maxJobs: number;
  pageAll: boolean;
  /** Lucene search start offset (for auto-widen paging). */
  start?: number;
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
  let start = Math.max(0, args.start ?? 0);
  const pageSize = Math.min(args.maxJobs, 100);
  const initialStart = start;

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

  if (jobsTotal === 0) jobsTotal = initialStart + jobRows.length;
  const jobsTruncated = jobsTotal > initialStart + jobRows.length;
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
  /** Reuse jobs across exhaustive windows (avoids reloading the same JobOrders). */
  preloadedJobs?: {
    jobRows: Array<Record<string, unknown>>;
    jobsTotal: number;
    jobsTruncated: boolean;
    jobIds: number[];
    jobTitleById: Map<number, string>;
  };
}): Promise<ScanPassResult> {
  const { jobRows, jobsTotal, jobsTruncated, jobIds, jobTitleById } =
    args.preloadedJobs ??
    (await loadDepartmentJobs({
      department: args.department,
      openJobsOnly: args.openJobsOnly,
      maxJobs: args.maxJobs,
      pageAll: args.pageAllJobs,
    }));

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
      submissionDepthTruncated: false,
      maxJobs: args.maxJobs,
      maxCandidatesToScan: args.maxCandidatesToScan,
    };
  }

  const applicants = new Map<number, ApplicantHit>();
  let applicantsTruncated = false;
  let submissionDepthTruncated = false;
  let submissionRowsSeen = 0;

  const jobIdSet = new Set(jobIds);
  const statusWhere =
    args.applicantPool === "responses"
      ? " AND (status='New Lead' OR status='Online Applicant')"
      : "";
  let dateWhere = "";
  if (args.dateAddedStartMs !== undefined) {
    dateWhere += ` AND dateAdded>=${args.dateAddedStartMs}`;
  }
  if (args.dateAddedEndMs !== undefined) {
    dateWhere += ` AND dateAdded<${args.dateAddedEndMs}`;
  }

  // Newest-first JobSubmission query so the note-scan budget keeps recent applicants.
  for (const batch of chunk(jobIds, JOB_ID_BATCH)) {
    const idWhere = batch.map((id) => `jobOrder.id=${id}`).join(" OR ");
    let start = 0;
    for (;;) {
      const page = (await queryJobSubmissions({
        where: `(${idWhere})${statusWhere}${dateWhere}`,
        fields: "id,status,candidate,jobOrder,dateAdded",
        count: SUBMISSION_PAGE,
        start,
        orderBy: "-dateAdded",
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
        const names = personName(row.candidate);
        const submissionMs =
          typeof row.dateAdded === "number" ? row.dateAdded : 0;
        const { incomplete } = upsertApplicantPreferRecent(
          applicants,
          {
            candidateId: candId,
            ...names,
            appliedJobIds: new Set(jid !== null ? [jid] : []),
            latestSubmissionMs: submissionMs,
          },
          args.maxCandidatesToScan,
        );
        if (incomplete) applicantsTruncated = true;
      }
      const total = typeof page.total === "number" ? page.total : undefined;
      start += rows.length;
      if (rows.length < SUBMISSION_PAGE) break;
      if (total !== undefined && start >= total) break;
      if (start >= SUBMISSION_PAGE_DEPTH) {
        submissionDepthTruncated = true;
        applicantsTruncated = true;
        break;
      }
    }
  }

  // Scan notes for newest applicants first (better "most recent" under budget).
  const applicantList = [...applicants.values()].sort(
    (a, b) => b.latestSubmissionMs - a.latestSubmissionMs,
  );
  const jobIdsArr = [...jobIdSet];
  const matches: MatchCandidate[] = [];

  await mapWithLimit(applicantList, NOTE_SCAN_CONCURRENCY, async (app) => {
    const notesRes = (await getNotes({
      candidateId: app.candidateId,
      returnAllLoaded: true,
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
    submissionDepthTruncated,
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
  resolvedFrom?: string;
}): unknown {
  return {
    department: args.department,
    ...(args.resolvedFrom
      ? { departmentResolvedFrom: args.resolvedFrom }
      : {}),
    noteAction: args.noteAction,
    openJobsOnly: args.openJobsOnly,
    applicantPool: args.applicantPool,
    mode: args.mode,
    uniqueCandidateCount: 0,
    candidates: [],
    jobsScanned: { count: 0, totalMatching: args.jobsTotal, truncated: false },
    applicantsScanned: { uniqueCandidates: 0, truncated: false },
    limits: { maxJobs: args.maxJobs, maxCandidatesToScan: args.maxCandidatesToScan },
    stopReason: "no_matching_jobs" as ScoutStopReason,
    confirmedComplete: true,
    definition:
      "Jobs by Internal Department (correlatedCustomText1) → inbound applicants " +
      "(JobSubmission Response bucket by default) → candidate notes with matching action " +
      "that reference a scanned job (jobOrder or comment Job ID).",
    note: `No jobs found for department "${args.department}" with the current filters. confirmedComplete=true — safe to say none under these filters (try openJobsOnly=false or another department nickname if the user meant something broader).`,
  };
}

export async function scoutQualifiedByDepartment(args: {
  department: string;
  noteAction?: string;
  openJobsOnly?: boolean;
  /** Default "responses" = Bullhorn Response tab (New Lead / Online Applicant). */
  applicantPool?: ScoutApplicantPool;
  /** Default "bounded". Use "exhaustive" for lookback counts via submission dates. */
  mode?: ScoutReportMode;
  /** Top-N most recent by note date — for "list 5 most recent" natural-language asks. */
  limit?: number;
  maxJobs?: number;
  maxCandidatesToScan?: number;
  dateAddedStart?: string;
  dateAddedEnd?: string;
}): Promise<unknown> {
  const resolved = await resolveDepartmentLabel(args.department);
  const department = resolved.department;
  const noteAction = (args.noteAction ?? DEFAULT_NOTE_ACTION).trim();
  if (!noteAction) throw new Error("noteAction must be a non-empty string.");
  const openJobsOnly = args.openJobsOnly !== false;
  const applicantPool: ScoutApplicantPool =
    args.applicantPool === "all" ? "all" : "responses";
  const mode: ScoutReportMode =
    args.mode === "exhaustive" ? "exhaustive" : "bounded";
  const limit =
    typeof args.limit === "number" && args.limit > 0
      ? Math.min(Math.floor(args.limit), 50)
      : undefined;

  let dateStartMs: number | undefined;
  let dateEndMs: number | undefined;
  if (args.dateAddedStart) {
    dateStartMs = parseScoutDateBound(args.dateAddedStart, false);
  }
  if (args.dateAddedEnd) {
    dateEndMs = parseScoutDateBound(args.dateAddedEnd, true);
  }

  // Natural-language path: top-N or default bounded — auto-page open jobs in ONE call.
  // Prefer this over exhaustive date windows for "most recent" / "list N" asks.
  // Keep paging until jobs exhausted or gateway wall — do not stop early for search caps.
  if (mode === "bounded" || limit !== undefined) {
    return runAutoWidenScout({
      department,
      resolvedFrom: resolved.resolvedFrom,
      noteAction,
      openJobsOnly,
      applicantPool,
      limit,
      maxJobsCap: Math.min(
        Math.max(args.maxJobs ?? AUTO_WIDEN_MAX_JOBS, 1),
        AUTO_WIDEN_MAX_JOBS,
      ),
      maxCandidatesPerPage: Math.min(
        Math.max(
          args.maxCandidatesToScan ?? AUTO_WIDEN_CANDIDATES_PER_PAGE,
          1,
        ),
        HARD_MAX_CANDIDATES,
      ),
      dateAddedStartMs: dateStartMs,
      dateAddedEndMs: dateEndMs,
    });
  }

  // --- exhaustive: submission-date windows (counts over a lookback) ---
  const hardMaxJobs = HARD_MAX_JOBS_EXHAUSTIVE;
  const maxJobs = Math.min(
    Math.max(args.maxJobs ?? DEFAULT_MAX_JOBS_EXHAUSTIVE, 1),
    hardMaxJobs,
  );
  const maxCandidatesToScan = Math.min(
    Math.max(args.maxCandidatesToScan ?? EXHAUSTIVE_PER_WINDOW_CANDIDATES, 1),
    HARD_MAX_CANDIDATES,
  );

  const startedAt = Date.now();
  const rangeEnd = dateEndMs ?? startedAt;
  const rangeStart =
    dateStartMs ??
    rangeEnd - EXHAUSTIVE_DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  if (!(rangeEnd > rangeStart)) {
    throw new Error("dateAddedEnd must be after dateAddedStart");
  }
  const windows = planExhaustiveDateWindows(rangeStart, rangeEnd);

  const preloadedJobs = await loadDepartmentJobs({
    department,
    openJobsOnly,
    maxJobs,
    pageAll: true,
  });

  const merged = new Map<number, MatchCandidate>();
  let jobsTruncated = preloadedJobs.jobsTruncated;
  let applicantsTruncated = false;
  let submissionDepthTruncated = false;
  let stoppedForWallTime = false;
  let jobsTotal = preloadedJobs.jobsTotal;
  let jobRows = preloadedJobs.jobRows;
  let jobIds = preloadedJobs.jobIds;
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
    if (Date.now() - startedAt >= EXHAUSTIVE_WALL_MS) {
      stoppedForWallTime = true;
      break;
    }
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
      preloadedJobs,
    });
    jobsTotal = pass.jobsTotal;
    jobRows = pass.jobRows;
    jobIds = pass.jobIds;
    if (pass.jobsTruncated) jobsTruncated = true;
    if (pass.applicantsTruncated) applicantsTruncated = true;
    if (pass.submissionDepthTruncated) submissionDepthTruncated = true;
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
      mode: "exhaustive",
      maxJobs,
      maxCandidatesToScan,
      jobsTotal,
      resolvedFrom: resolved.resolvedFrom,
    });
  }

  const matches = rankAndLimitMatches([...merged.values()], limit);
  const windowsPlanned = windows.length;
  const windowsCompleted = windowSummaries.length;
  const incomplete =
    jobsTruncated ||
    applicantsTruncated ||
    stoppedForWallTime ||
    windowsCompleted < windowsPlanned;
  const stopReason = resolveScoutStopReason({
    stoppedForWallTime,
    jobsTruncated,
    applicantsTruncated,
    submissionDepthTruncated,
  });
  const confirmedComplete = stopReason === "complete" && !incomplete;

  return {
    department,
    ...(resolved.resolvedFrom ? { departmentResolvedFrom: resolved.resolvedFrom } : {}),
    noteAction,
    openJobsOnly,
    applicantPool,
    mode: "exhaustive",
    ...(limit !== undefined ? { limit } : {}),
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
      windows: windowsCompleted,
    },
    exhaustive: {
      dateAddedStart: new Date(rangeStart).toISOString().slice(0, 10),
      dateAddedEnd: new Date(rangeEnd).toISOString().slice(0, 10),
      defaultLookbackDays: EXHAUSTIVE_DEFAULT_LOOKBACK_DAYS,
      windowCount: windowsCompleted,
      windowsPlanned,
      wallMs: EXHAUSTIVE_WALL_MS,
      elapsedMs: Date.now() - startedAt,
      stoppedForWallTime,
      windows: windowSummaries,
    },
    limits: {
      maxJobs,
      maxCandidatesToScan,
      maxWindows: EXHAUSTIVE_MAX_WINDOWS,
      wallMs: EXHAUSTIVE_WALL_MS,
    },
    stopReason,
    confirmedComplete,
    definition:
      "mode=exhaustive: partitions JobSubmission dateAdded into windows in ONE call. " +
      "For 'list N most recent' prefer default bounded mode with limit=N (ranks by note date). " +
      "Stop only when confirmedComplete=true or stopReason is a real connector/gateway limit.",
    ...(incomplete
      ? {
          incomplete: true,
          note: incompleteGuidanceNote("exhaustive", {
            stoppedForWallTime,
            matchCount: matches.length,
          }),
        }
      : {
          note:
            "Exhaustive single-call scan completed without per-window truncation " +
            "in the date range shown. Still not a global Note Lucene total (Bullhorn Note index unavailable).",
        }),
  };
}

async function runAutoWidenScout(args: {
  department: string;
  resolvedFrom?: string;
  noteAction: string;
  openJobsOnly: boolean;
  applicantPool: ScoutApplicantPool;
  limit?: number;
  maxJobsCap: number;
  maxCandidatesPerPage: number;
  dateAddedStartMs?: number;
  dateAddedEndMs?: number;
}): Promise<unknown> {
  const startedAt = Date.now();
  const merged = new Map<number, MatchCandidate>();
  const allJobRows: Array<Record<string, unknown>> = [];
  const allJobIds: number[] = [];
  let jobsTotal = 0;
  let jobStart = 0;
  let submissionRowsSeen = 0;
  let applicantsUnique = 0;
  let applicantsTruncated = false;
  let submissionDepthTruncated = false;
  let stoppedForWallTime = false;
  let pages = 0;

  while (jobStart < args.maxJobsCap) {
    if (Date.now() - startedAt >= EXHAUSTIVE_WALL_MS) {
      stoppedForWallTime = true;
      break;
    }

    const pageBudget = Math.min(AUTO_WIDEN_JOB_PAGE, args.maxJobsCap - jobStart);
    const batch = await loadDepartmentJobs({
      department: args.department,
      openJobsOnly: args.openJobsOnly,
      maxJobs: pageBudget,
      pageAll: false,
      start: jobStart,
    });
    jobsTotal = batch.jobsTotal;
    pages += 1;

    if (batch.jobIds.length === 0) break;

    const pass = await runScoutScanPass({
      department: args.department,
      noteAction: args.noteAction,
      openJobsOnly: args.openJobsOnly,
      applicantPool: args.applicantPool,
      maxJobs: batch.jobIds.length,
      maxCandidatesToScan: args.maxCandidatesPerPage,
      pageAllJobs: false,
      dateAddedStartMs: args.dateAddedStartMs,
      dateAddedEndMs: args.dateAddedEndMs,
      preloadedJobs: batch,
    });
    mergeMatches(merged, pass.matches);
    submissionRowsSeen += pass.submissionRowsSeen;
    applicantsUnique += pass.applicantsUnique;
    if (pass.applicantsTruncated) applicantsTruncated = true;
    if (pass.submissionDepthTruncated) submissionDepthTruncated = true;
    for (const row of batch.jobRows) {
      allJobRows.push(row);
      if (typeof row.id === "number") allJobIds.push(row.id);
    }

    jobStart += batch.jobIds.length;
    if (jobStart >= jobsTotal) break;
    // Keep paging until jobs exhausted or wall — never stop early just because
    // a first page already found matches (that was the false-zero / undercount bug).
  }

  if (allJobIds.length === 0) {
    return emptyNoJobsResult({
      department: args.department,
      noteAction: args.noteAction,
      openJobsOnly: args.openJobsOnly,
      applicantPool: args.applicantPool,
      mode: "bounded",
      maxJobs: args.maxJobsCap,
      maxCandidatesToScan: args.maxCandidatesPerPage,
      jobsTotal,
      resolvedFrom: args.resolvedFrom,
    });
  }

  const ranked = rankAndLimitMatches([...merged.values()], args.limit);
  const jobsTruncated = jobStart < jobsTotal || allJobIds.length < jobsTotal;
  const incomplete =
    jobsTruncated ||
    applicantsTruncated ||
    stoppedForWallTime ||
    submissionDepthTruncated;
  const stopReason = resolveScoutStopReason({
    stoppedForWallTime,
    jobsTruncated,
    applicantsTruncated,
    submissionDepthTruncated,
  });
  const confirmedComplete = stopReason === "complete" && !incomplete;

  let userNote: string;
  if (incomplete && ranked.length === 0) {
    userNote = incompleteGuidanceNote("bounded", {
      stoppedForWallTime,
      matchCount: 0,
    });
  } else if (incomplete && args.limit !== undefined && ranked.length > 0) {
    userNote =
      `Showing the ${ranked.length} most recent matching candidate(s) found while scanning open jobs in this department. ` +
      (jobsTruncated || stoppedForWallTime
        ? "More (or more recent) matches may exist on jobs not yet scanned — treat as a partial ranked list. "
        : "") +
      `stopReason=${stopReason}; confirmedComplete=false. Present these names. ` +
      INCOMPLETE_NO_FANOUT +
      " Ask a clarifying question only if they need a fuller/more recent set.";
  } else if (incomplete) {
    userNote = incompleteGuidanceNote("bounded", {
      stoppedForWallTime,
      matchCount: ranked.length,
    });
  } else if (args.limit !== undefined) {
    userNote = `Top ${ranked.length} most recent matching candidates by Scout/note date among open-department jobs. confirmedComplete=true.`;
  } else {
    userNote =
      "Unique matching candidates among the open-department applicant pool for scanned jobs. confirmedComplete=true.";
  }

  return {
    department: args.department,
    ...(args.resolvedFrom
      ? { departmentResolvedFrom: args.resolvedFrom }
      : {}),
    noteAction: args.noteAction,
    openJobsOnly: args.openJobsOnly,
    applicantPool: args.applicantPool,
    mode: "bounded",
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    uniqueCandidateCount: ranked.length,
    candidates: ranked,
    jobsScanned: {
      count: allJobIds.length,
      totalMatching: jobsTotal,
      truncated: jobsTruncated,
      pages,
      jobs: allJobRows.slice(0, 50).map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        isOpen: r.isOpen,
      })),
    },
    applicantsScanned: {
      uniqueCandidates: applicantsUnique,
      submissionRowsSeen,
      truncated: applicantsTruncated,
    },
    autoWiden: {
      elapsedMs: Date.now() - startedAt,
      wallMs: EXHAUSTIVE_WALL_MS,
      stoppedForWallTime,
      rankedBy: "latestMatchingNoteDate",
    },
    limits: {
      maxJobs: args.maxJobsCap,
      maxCandidatesToScan: args.maxCandidatesPerPage,
      wallMs: EXHAUSTIVE_WALL_MS,
    },
    stopReason,
    confirmedComplete,
    definition:
      "Natural-language Scout/screening report: resolve Internal Department nicknames, " +
      "scan OPEN jobs until exhausted or gateway wall, match Response applicants with the given note action " +
      "(jobOrder or comment Job ID), rank by latest matching note date. " +
      "Pass limit=N for 'N most recent'. Stop working only when confirmedComplete=true " +
      "or stopReason is a real connector/gateway limit — never because of an arbitrary early search cap.",
    ...(incomplete ? { incomplete: true, note: userNote } : { note: userNote }),
  };
}

/** Re-export for tests that assert comment parsing stays wired. */
export { parseJobIdsFromNoteComments, noteReferencesJob };
