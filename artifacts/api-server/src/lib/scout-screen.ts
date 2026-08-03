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
/**
 * Top-N / list asks get a slightly longer soft wall so we can finish typical
 * open-dept pools (~250–300 jobs) after newest-first ordering. Still under
 * common ChatGPT/gateway ~120s 504 thresholds.
 */
export const TOPN_WALL_MS = 95_000;
/**
 * Hard safety max for in-process async report jobs (no ChatGPT soft wall).
 * Sync path keeps TOPN_WALL_MS / EXHAUSTIVE_WALL_MS unchanged.
 */
export const ASYNC_REPORT_WALL_MS = 20 * 60 * 1000;
/** Fewer jobs per note-scan page after newest-first preload. */
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

/**
 * Universal AI blocker contract (all departments / all scout paths):
 * Soft walls are ChatGPT/channel realism — never raise sync TOPN/EXHAUSTIVE walls.
 * wall_time is never a dead end: continue via start_scout_dept_report_job + get_report_job.
 * Never date-window fan-out. Never give up solely because of the soft wall.
 */
export const ASYNC_CONTINUATION_HINT =
  "Soft wall is channel realism, not a final answer. Call start_scout_dept_report_job with the same " +
  "arguments, then poll get_report_job until status is complete or failed. " +
  "Do NOT fan out date windows. Do NOT give up because of wall_time.";

/** Machine-readable continuation payload — same shape on every wall_time path. */
export function buildAsyncContinuation(args?: {
  /** Echo of the scout args so the model can re-issue without improvising. */
  resumeArgs?: Record<string, unknown>;
}): {
  tool: "start_scout_dept_report_job";
  pollTool: "get_report_job";
  hint: string;
  resumeArgs?: Record<string, unknown>;
} {
  return {
    tool: "start_scout_dept_report_job",
    pollTool: "get_report_job",
    hint: ASYNC_CONTINUATION_HINT,
    ...(args?.resumeArgs ? { resumeArgs: args.resumeArgs } : {}),
  };
}

const INCOMPLETE_PARTIAL_RESULTS =
  "uniqueCandidateCount is a LOWER BOUND / partial ranked list for this single call. " +
  "Present these results to the user. Do NOT invent more names. " +
  "Check stopReason / confirmedComplete: treat the task as unfinished until " +
  "confirmedComplete is true, OR you have continued via start_scout_dept_report_job " +
  "and get_report_job finished, OR stopReason is a true unworkable connector limit " +
  "(e.g. no_matching_jobs) — wall_time alone is NOT a dead end. " +
  INCOMPLETE_NO_FANOUT +
  " If filters are ambiguous, ask one clarifying question; otherwise continue with async or one broader/exhaustive call.";

const INCOMPLETE_ZERO_NOT_CONFIRMED =
  "uniqueCandidateCount is 0 but confirmedComplete is false — " +
  "this is NOT a confirmed zero. Do NOT tell the user there are no matching candidates. " +
  "Say the first pass found none in the scanned portion, then either ask one clarifying question " +
  "(confirm department, include closed jobs, all applicants vs responses) " +
  "and/or call start_scout_dept_report_job (same args) / one broader scout_dept_report or mode=exhaustive. " +
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

export async function listInternalDepartments(): Promise<string[]> {
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
    ? "Scan stopped early under the ChatGPT/gateway soft wall (stopReason=wall_time) — channel realism, not a final answer. "
    : "";
  const asyncHint = opts?.stoppedForWallTime
    ? ` ${ASYNC_CONTINUATION_HINT}`
    : "";
  const zeroUnconfirmed =
    typeof opts?.matchCount === "number" && opts.matchCount === 0;

  if (zeroUnconfirmed) {
    return wall + INCOMPLETE_ZERO_NOT_CONFIRMED + asyncHint;
  }

  if (mode === "exhaustive") {
    return (
      wall +
      "Result may still be incomplete after server-side date partitioning (job and/or " +
      "per-window applicant caps, or wall-time budget). " +
      INCOMPLETE_PARTIAL_RESULTS +
      " Prefer an explicit recent dateAddedStart/dateAddedEnd (e.g. last 2–3 weeks) with mode=exhaustive." +
      asyncHint
    );
  }
  return (
    wall +
    "Result set may be incomplete (jobs/applicants still unscanned, or wall). " +
    INCOMPLETE_PARTIAL_RESULTS +
    asyncHint
  );
}

/** Append async continuation when a sync result stopped on wall_time (universal). */
export function withAsyncContinuationHint<T extends Record<string, unknown>>(
  result: T,
  opts?: { resumeArgs?: Record<string, unknown> },
): T {
  if (result.stopReason !== "wall_time") return result;
  const note =
    typeof result.note === "string" ? result.note : undefined;
  if (note && note.includes("start_scout_dept_report_job")) {
    // Ensure machine-readable field even if note already mentions the tool.
    if (result.asyncContinuation) return result;
    return {
      ...result,
      asyncContinuation: buildAsyncContinuation({
        resumeArgs: opts?.resumeArgs,
      }),
    };
  }
  return {
    ...result,
    asyncContinuation: buildAsyncContinuation({
      resumeArgs: opts?.resumeArgs,
    }),
    ...(note
      ? { note: `${note} ${ASYNC_CONTINUATION_HINT}` }
      : { note: ASYNC_CONTINUATION_HINT }),
  };
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
  /**
   * True when at least one JobSubmission for this candidate on the scanned jobs
   * was in the Response bucket (New Lead / Online Applicant).
   */
  hadResponseSubmission?: boolean;
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
    if (hit.hadResponseSubmission) existing.hadResponseSubmission = true;
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

export async function loadDepartmentJobs(args: {
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

/** Newest open jobs first — critical when the gateway wall cuts a scan short. */
export function sortJobsNewestFirst(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return [...rows].sort((a, b) => {
    const da = typeof a.dateAdded === "number" ? a.dateAdded : 0;
    const db = typeof b.dateAdded === "number" ? b.dateAdded : 0;
    if (db !== da) return db - da;
    const ia = typeof a.id === "number" ? a.id : 0;
    const ib = typeof b.id === "number" ? b.id : 0;
    return ib - ia;
  });
}

/**
 * Top-N completeness proof used after newest-first scanning.
 *
 * When we already hold `limit` matches ranked by note date, and every *remaining*
 * unscanned job has JobOrder.dateAdded strictly older than the Nth match's note
 * date, no newer qualifying note can appear on those older jobs under the
 * newest-first open-job walk — return confirmedComplete without scanning them.
 *
 * Unsafe for `applicantPool === "all"`: Scout notes on older jobs can still be
 * newer than the Nth match (e.g. a fresh Scout Screen on a months-old job).
 * Never claim confirmedComplete via this heuristic for the full submission pool.
 *
 * Requires `rankedMatches` already sorted newest-note-first and length >= limit.
 */
export function canConfirmTopNByJobRecency(args: {
  limit: number;
  /** Newest-first by latest matching note date. */
  rankedMatches: Array<{ latestNoteDate?: number }>;
  /** Jobs not yet included in the note-scan / applicant walk. */
  remainingJobs: Array<{ dateAdded?: unknown }>;
  /**
   * When "all", always refuse — job.dateAdded cannot bound note dates across
   * the full JobSubmission pool.
   */
  applicantPool?: ScoutApplicantPool;
}): boolean {
  const { limit, rankedMatches, remainingJobs, applicantPool } = args;
  // Notes on older jobs can still beat the Nth match when walking every
  // submission — never skip remaining jobs via job-recency for pool=all.
  // Empty remaining is still complete (jobs exhausted).
  if (applicantPool === "all" && remainingJobs.length > 0) return false;
  if (!(limit > 0) || rankedMatches.length < limit) return false;
  if (remainingJobs.length === 0) return true;
  const nth = rankedMatches[limit - 1];
  const nthMs =
    typeof nth?.latestNoteDate === "number" ? nth.latestNoteDate : 0;
  if (!(nthMs > 0)) return false;
  return remainingJobs.every((job) => {
    const added = typeof job.dateAdded === "number" ? job.dateAdded : 0;
    // Missing dateAdded → cannot prove the job is older than the Nth note.
    if (!(added > 0)) return false;
    return added < nthMs;
  });
}

function jobsBundleFromRows(
  jobRows: Array<Record<string, unknown>>,
  jobsTotal: number,
  jobsTruncated: boolean,
): {
  jobRows: Array<Record<string, unknown>>;
  jobsTotal: number;
  jobsTruncated: boolean;
  jobIds: number[];
  jobTitleById: Map<number, string>;
} {
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

export async function collectApplicantsForJobs(args: {
  jobIds: number[];
  applicantPool: ScoutApplicantPool;
  maxCandidatesToScan: number;
  dateAddedStartMs?: number;
  dateAddedEndMs?: number;
  /** Optional wall: stop collecting more job batches when exceeded. */
  shouldStop?: () => boolean;
}): Promise<{
  applicants: Map<number, ApplicantHit>;
  submissionRowsSeen: number;
  applicantsTruncated: boolean;
  submissionDepthTruncated: boolean;
  jobIdsFullyCollected: number[];
  stoppedEarly: boolean;
}> {
  const applicants = new Map<number, ApplicantHit>();
  let applicantsTruncated = false;
  let submissionDepthTruncated = false;
  let submissionRowsSeen = 0;
  const jobIdsFullyCollected: number[] = [];
  let stoppedEarly = false;

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

  for (const batch of chunk(args.jobIds, JOB_ID_BATCH)) {
    if (args.shouldStop?.()) {
      stoppedEarly = true;
      break;
    }
    const idWhere = batch.map((id) => `jobOrder.id=${id}`).join(" OR ");
    let start = 0;
    let batchDepthTruncated = false;
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
        const isResponse = classifySubmissionStage(status) === "response";
        const { incomplete } = upsertApplicantPreferRecent(
          applicants,
          {
            candidateId: candId,
            ...names,
            appliedJobIds: new Set(jid !== null ? [jid] : []),
            latestSubmissionMs: submissionMs,
            // Response-only pools are all response applicants by definition.
            hadResponseSubmission:
              args.applicantPool === "responses" ? true : isResponse,
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
        batchDepthTruncated = true;
        break;
      }
    }
    if (!batchDepthTruncated) {
      jobIdsFullyCollected.push(...batch);
    }
  }

  return {
    applicants,
    submissionRowsSeen,
    applicantsTruncated,
    submissionDepthTruncated,
    jobIdsFullyCollected,
    stoppedEarly,
  };
}

/**
 * Scout Screen notes live on the Candidate association (jobOrder often null; Job ID
 * in comments). JobOrder.notes miss them — measured live on STSI job 34829 vs
 * candidate 4673061 — so this path is always candidate-scoped.
 */
async function matchApplicantsByCandidateNotes(args: {
  applicants: ApplicantHit[];
  noteAction: string;
  departmentJobIds: number[];
  jobTitleById: Map<number, string>;
  shouldStop?: () => boolean;
  /**
   * After each concurrency batch, if this returns true we stop note-scanning
   * further applicants (top-N early exit).
   */
  shouldStopAfterMatches?: (matches: MatchCandidate[]) => boolean;
}): Promise<{ matches: MatchCandidate[]; scannedCount: number; stoppedEarly: boolean }> {
  const matches: MatchCandidate[] = [];
  const jobIdsArr = args.departmentJobIds;
  let scannedCount = 0;
  let stoppedEarly = false;

  const sorted = [...args.applicants].sort(
    (a, b) => b.latestSubmissionMs - a.latestSubmissionMs,
  );

  for (const batch of chunk(sorted, NOTE_SCAN_CONCURRENCY)) {
    if (args.shouldStop?.()) {
      stoppedEarly = true;
      break;
    }
    await mapWithLimit(batch, NOTE_SCAN_CONCURRENCY, async (app) => {
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
          ...(args.jobTitleById.has(id)
            ? { title: args.jobTitleById.get(id) }
            : {}),
        })),
        notes: matchedNotes,
      });
    });
    scannedCount += batch.length;

    if (args.shouldStopAfterMatches?.(matches)) {
      stoppedEarly = true;
      break;
    }
  }

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

  return { matches, scannedCount, stoppedEarly };
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

  const collected = await collectApplicantsForJobs({
    jobIds,
    applicantPool: args.applicantPool,
    maxCandidatesToScan: args.maxCandidatesToScan,
    dateAddedStartMs: args.dateAddedStartMs,
    dateAddedEndMs: args.dateAddedEndMs,
  });

  const { matches } = await matchApplicantsByCandidateNotes({
    applicants: [...collected.applicants.values()],
    noteAction: args.noteAction,
    departmentJobIds: jobIds,
    jobTitleById,
  });

  return {
    matches,
    jobRows,
    jobsTotal,
    jobsTruncated,
    jobIds,
    applicantsUnique: collected.applicants.size,
    submissionRowsSeen: collected.submissionRowsSeen,
    applicantsTruncated: collected.applicantsTruncated,
    submissionDepthTruncated: collected.submissionDepthTruncated,
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
  /**
   * Optional wall override for async report jobs. Sync callers must omit this
   * so TOPN_WALL_MS / EXHAUSTIVE_WALL_MS stay in force. When set above the sync
   * soft walls, an incomplete snapshot+live_tail result falls through to a
   * live association walk instead of returning wall_time early.
   */
  wallMs?: number;
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
  const wallMsOverride =
    typeof args.wallMs === "number" && args.wallMs > 0
      ? args.wallMs
      : undefined;
  const asyncBudget =
    wallMsOverride !== undefined && wallMsOverride > TOPN_WALL_MS;

  const resumeArgs: Record<string, unknown> = {
    department: args.department,
    noteAction,
    openJobsOnly,
    applicantPool,
    mode,
    ...(limit !== undefined ? { limit } : {}),
    ...(args.maxJobs !== undefined ? { maxJobs: args.maxJobs } : {}),
    ...(args.maxCandidatesToScan !== undefined
      ? { maxCandidatesToScan: args.maxCandidatesToScan }
      : {}),
    ...(args.dateAddedStart ? { dateAddedStart: args.dateAddedStart } : {}),
    ...(args.dateAddedEnd ? { dateAddedEnd: args.dateAddedEnd } : {}),
  };
  const attachContinuation = (result: Record<string, unknown>) =>
    withAsyncContinuationHint(result, { resumeArgs });

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
    const { tryServeScoutFromSnapshot } = await import(
      "./note-snapshot-read.js"
    );
    const fromSnapshot = await tryServeScoutFromSnapshot({
      department,
      resolvedFrom: resolved.resolvedFrom,
      noteAction,
      openJobsOnly,
      applicantPool,
      mode: "bounded",
      limit,
      dateAddedStartMs: dateStartMs,
      dateAddedEndMs: dateEndMs,
    });
    if (fromSnapshot) {
      const snap = fromSnapshot as {
        confirmedComplete?: boolean;
        stopReason?: string;
      };
      // Sync: always return snapshot path. Async high-wall: fall through when
      // snapshot+tail was incomplete so the live walk can finish.
      if (
        !asyncBudget ||
        snap.confirmedComplete === true ||
        snap.stopReason !== "wall_time"
      ) {
        return attachContinuation(fromSnapshot as Record<string, unknown>);
      }
    }

    const luceneFirst = await tryScoutViaNoteLucene({
      department,
      resolvedFrom: resolved.resolvedFrom,
      noteAction,
      openJobsOnly,
      applicantPool,
      limit,
      dateAddedStartMs: dateStartMs,
      dateAddedEndMs: dateEndMs,
    });
    if (luceneFirst) {
      return attachContinuation(luceneFirst as Record<string, unknown>);
    }

    return attachContinuation(
      (await runAutoWidenScout({
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
        wallMs: wallMsOverride,
      })) as Record<string, unknown>,
    );
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
  const wallMs = wallMsOverride ?? EXHAUSTIVE_WALL_MS;
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
    if (Date.now() - startedAt >= wallMs) {
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

  return attachContinuation({
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
      wallMs,
      elapsedMs: Date.now() - startedAt,
      stoppedForWallTime,
      windows: windowSummaries,
    },
    limits: {
      maxJobs,
      maxCandidatesToScan,
      maxWindows: EXHAUSTIVE_MAX_WINDOWS,
      wallMs,
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
  });
}

/**
 * Feature-detect Bullhorn Note Lucene. Returns null when the index is empty
 * (current Myticas state) so callers fall back to the association walk.
 */
export async function probeNoteLuceneAvailable(): Promise<boolean> {
  try {
    const res = (await searchAnyEntity({
      entityType: "Note",
      query: "id:[1 TO *]",
      fields: "id",
      count: 1,
      start: 0,
    })) as { total?: number };
    return typeof res.total === "number" && res.total > 0;
  } catch {
    return false;
  }
}

/**
 * When Note Lucene works: search notes by action (+ optional date), join to
 * department jobs, rank by note date. Returns null to trigger association fallback.
 */
async function tryScoutViaNoteLucene(args: {
  department: string;
  resolvedFrom?: string;
  noteAction: string;
  openJobsOnly: boolean;
  applicantPool: ScoutApplicantPool;
  limit?: number;
  dateAddedStartMs?: number;
  dateAddedEndMs?: number;
}): Promise<unknown | null> {
  const available = await probeNoteLuceneAvailable();
  if (!available) return null;

  const preloaded = await loadDepartmentJobs({
    department: args.department,
    openJobsOnly: args.openJobsOnly,
    maxJobs: AUTO_WIDEN_MAX_JOBS,
    pageAll: true,
  });
  if (preloaded.jobIds.length === 0) {
    return emptyNoJobsResult({
      department: args.department,
      noteAction: args.noteAction,
      openJobsOnly: args.openJobsOnly,
      applicantPool: args.applicantPool,
      mode: "bounded",
      maxJobs: AUTO_WIDEN_MAX_JOBS,
      maxCandidatesToScan: HARD_MAX_CANDIDATES,
      jobsTotal: preloaded.jobsTotal,
      resolvedFrom: args.resolvedFrom,
    });
  }

  const actionClause = `action:"${escapeLucenePhrase(args.noteAction)}"`;
  let dateClause = "";
  if (args.dateAddedStartMs !== undefined) {
    dateClause += ` AND dateAdded:[${args.dateAddedStartMs} TO *]`;
  }
  if (args.dateAddedEndMs !== undefined) {
    dateClause += ` AND dateAdded:[* TO ${Math.max(0, args.dateAddedEndMs - 1)}]`;
  }

  const matchesByCandidate = new Map<number, MatchCandidate>();
  const pageSize = 50;
  let start = 0;
  for (;;) {
    const page = (await searchAnyEntity({
      entityType: "Note",
      query: `${actionClause}${dateClause}`,
      fields: "id,action,comments,jobOrder,dateAdded,personReference,candidates",
      count: pageSize,
      start,
    })) as {
      total?: number;
      data?: Array<Record<string, unknown>>;
    };
    const rows = Array.isArray(page.data) ? page.data : [];
    if (rows.length === 0) break;

    for (const note of rows) {
      const hitJobs = preloaded.jobIds.filter((jid) =>
        noteReferencesJob(note, jid),
      );
      if (hitJobs.length === 0) continue;
      let candidateId: number | null = null;
      for (const ref of [note.personReference, note.candidates]) {
        if (ref && typeof ref === "object" && !Array.isArray(ref)) {
          const id = (ref as { id?: unknown }).id;
          if (typeof id === "number" && id > 0) {
            candidateId = id;
            break;
          }
        }
      }
      if (candidateId === null) continue;

      const names =
        personName(note.personReference) || personName(note.candidates);
      const existing = matchesByCandidate.get(candidateId);
      const noteEntry: MatchNote = {
        noteId: typeof note.id === "number" ? note.id : 0,
        action: args.noteAction,
        matchedJobIds: hitJobs,
        ...(typeof note.dateAdded === "number"
          ? { dateAdded: note.dateAdded }
          : {}),
      };
      if (!existing) {
        matchesByCandidate.set(candidateId, {
          id: candidateId,
          ...names,
          matchedJobIds: [...hitJobs],
          matchedJobs: hitJobs.map((id) => ({
            id,
            ...(preloaded.jobTitleById.has(id)
              ? { title: preloaded.jobTitleById.get(id) }
              : {}),
          })),
          notes: [noteEntry],
        });
      } else {
        for (const jid of hitJobs) {
          if (!existing.matchedJobIds.includes(jid)) {
            existing.matchedJobIds.push(jid);
            existing.matchedJobs.push({
              id: jid,
              ...(preloaded.jobTitleById.has(jid)
                ? { title: preloaded.jobTitleById.get(jid) }
                : {}),
            });
          }
        }
        if (!existing.notes.some((n) => n.noteId === noteEntry.noteId)) {
          existing.notes.push(noteEntry);
        }
      }
    }

    start += rows.length;
    if (rows.length < pageSize) break;
    if (typeof page.total === "number" && start >= page.total) break;
    // Safety: don't pull unbounded note history in one ChatGPT turn.
    if (start >= 2000) break;
  }

  const ranked = rankAndLimitMatches(
    [...matchesByCandidate.values()],
    args.limit,
  );

  // Enrich bullhornUrl for the page we return.
  if (ranked.length > 0) {
    const idOr = ranked.map((m) => m.id).slice(0, 50).join(" OR ");
    const enriched = (await searchAnyEntity({
      entityType: "Candidate",
      query: `id:(${idOr})`,
      fields: "id,firstName,lastName",
      count: Math.min(ranked.length, 50),
      start: 0,
    })) as { data?: Array<Record<string, unknown>> };
    const byId = new Map<number, Record<string, unknown>>();
    for (const row of Array.isArray(enriched.data) ? enriched.data : []) {
      if (typeof row.id === "number") byId.set(row.id, row);
    }
    for (const m of ranked) {
      const row = byId.get(m.id);
      if (row && typeof row.bullhornUrl === "string") m.bullhornUrl = row.bullhornUrl;
      if (!m.firstName && typeof row?.firstName === "string") m.firstName = row.firstName;
      if (!m.lastName && typeof row?.lastName === "string") m.lastName = row.lastName;
    }
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
      count: preloaded.jobIds.length,
      totalMatching: preloaded.jobsTotal,
      truncated: preloaded.jobsTruncated,
      order: "dateAddedDesc",
      path: "note_lucene",
    },
    applicantsScanned: {
      uniqueCandidates: matchesByCandidate.size,
      truncated: false,
    },
    autoWiden: {
      noteScanPath: "lucene",
      rankedBy: "latestMatchingNoteDate",
      luceneAvailable: true,
    },
    limits: { maxJobs: AUTO_WIDEN_MAX_JOBS, wallMs: TOPN_WALL_MS },
    stopReason: "complete" as ScoutStopReason,
    confirmedComplete: true,
    definition:
      "Note Lucene path: search Note.action then join to department JobOrders. " +
      "Used only when /search/Note returns non-zero totals.",
    note: `Lucene Note search path. Top ${ranked.length} match(es) for department "${args.department}". confirmedComplete=true.`,
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
  /** Override ChatGPT soft wall (async jobs). Sync path omits → TOPN/EXHAUSTIVE defaults. */
  wallMs?: number;
}): Promise<unknown> {
  const startedAt = Date.now();
  const wallMs =
    args.wallMs ??
    (args.limit !== undefined ? TOPN_WALL_MS : EXHAUSTIVE_WALL_MS);
  const wallHit = () => Date.now() - startedAt >= wallMs;

  const merged = new Map<number, MatchCandidate>();
  const allJobRows: Array<Record<string, unknown>> = [];
  const allJobIds: number[] = [];
  const noteScannedCandidateIds = new Set<number>();
  let submissionRowsSeen = 0;
  let applicantsUnique = 0;
  let noteScanned = 0;
  let applicantsTruncated = false;
  let submissionDepthTruncated = false;
  let stoppedForWallTime = false;
  let stoppedForTopNProof = false;
  let pages = 0;

  // Preload jobs, then scan newest-first *page by page*: applicants + notes for
  // each page before the next. That lets top-N early-exit as soon as remaining
  // unscanned jobs are older than the Nth note — without burning the wall on a
  // full-dept submission crawl first (MYT-scale pools).
  const preloaded = await loadDepartmentJobs({
    department: args.department,
    openJobsOnly: args.openJobsOnly,
    maxJobs: args.maxJobsCap,
    pageAll: true,
  });
  const jobsTotal = preloaded.jobsTotal;
  const sortedRows = sortJobsNewestFirst(preloaded.jobRows).slice(
    0,
    args.maxJobsCap,
  );
  const jobsTruncatedAtLoad =
    preloaded.jobsTruncated || sortedRows.length < jobsTotal;

  if (sortedRows.length === 0) {
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

  for (let offset = 0; offset < sortedRows.length; offset += AUTO_WIDEN_JOB_PAGE) {
    if (wallHit()) {
      stoppedForWallTime = true;
      break;
    }

    const slice = sortedRows.slice(offset, offset + AUTO_WIDEN_JOB_PAGE);
    if (slice.length === 0) break;
    pages += 1;

    const batch = jobsBundleFromRows(slice, jobsTotal, false);
    const collected = await collectApplicantsForJobs({
      jobIds: batch.jobIds,
      applicantPool: args.applicantPool,
      maxCandidatesToScan: args.maxCandidatesPerPage,
      dateAddedStartMs: args.dateAddedStartMs,
      dateAddedEndMs: args.dateAddedEndMs,
      shouldStop: wallHit,
    });
    if (collected.stoppedEarly && wallHit()) stoppedForWallTime = true;
    if (collected.applicantsTruncated) applicantsTruncated = true;
    if (collected.submissionDepthTruncated) submissionDepthTruncated = true;
    submissionRowsSeen += collected.submissionRowsSeen;
    applicantsUnique += collected.applicants.size;

    const applicantsToScan = [...collected.applicants.values()].filter(
      (a) => !noteScannedCandidateIds.has(a.candidateId),
    );
    const noteScan = await matchApplicantsByCandidateNotes({
      applicants: applicantsToScan,
      noteAction: args.noteAction,
      // Match notes against any department job (comment Job IDs may predate this page).
      departmentJobIds: sortedRows
        .map((r) => (typeof r.id === "number" ? r.id : null))
        .filter((id): id is number => id !== null),
      jobTitleById: preloaded.jobTitleById,
      shouldStop: () => {
        if (wallHit()) {
          stoppedForWallTime = true;
          return true;
        }
        return false;
      },
    });
    noteScanned += noteScan.scannedCount;
    for (const a of applicantsToScan) {
      noteScannedCandidateIds.add(a.candidateId);
    }
    mergeMatches(merged, noteScan.matches);

    for (const row of batch.jobRows) {
      allJobRows.push(row);
      if (typeof row.id === "number") allJobIds.push(row.id);
    }

    // Top-N early-exit: remaining = jobs not yet walked. Do not claim completeness
    // if this page truncated applicants (unscanned applicants on scanned jobs).
    if (
      args.limit !== undefined &&
      !collected.applicantsTruncated &&
      !collected.submissionDepthTruncated &&
      !collected.stoppedEarly
    ) {
      const rankedSoFar = rankAndLimitMatches([...merged.values()], args.limit);
      const remainingJobs = sortedRows.slice(offset + AUTO_WIDEN_JOB_PAGE);
      if (
        canConfirmTopNByJobRecency({
          limit: args.limit,
          rankedMatches: rankedSoFar,
          remainingJobs,
          applicantPool: args.applicantPool,
        })
      ) {
        stoppedForTopNProof = true;
        break;
      }
    }

    if (stoppedForWallTime) break;
  }

  const ranked = rankAndLimitMatches([...merged.values()], args.limit);
  const jobsTruncated =
    jobsTruncatedAtLoad ||
    (!stoppedForTopNProof && allJobIds.length < sortedRows.length) ||
    (!stoppedForTopNProof && allJobIds.length < jobsTotal);
  const incomplete =
    (!stoppedForTopNProof && jobsTruncated) ||
    (!stoppedForTopNProof && applicantsTruncated) ||
    (stoppedForWallTime && !stoppedForTopNProof) ||
    (!stoppedForTopNProof && submissionDepthTruncated);
  const stopReason = stoppedForTopNProof
    ? "complete"
    : resolveScoutStopReason({
        stoppedForWallTime,
        jobsTruncated: jobsTruncated && !stoppedForTopNProof,
        applicantsTruncated: applicantsTruncated && !stoppedForTopNProof,
        submissionDepthTruncated:
          submissionDepthTruncated && !stoppedForTopNProof,
      });
  const confirmedComplete =
    (stopReason === "complete" && !incomplete) || stoppedForTopNProof;

  let userNote: string;
  if (incomplete && ranked.length === 0) {
    userNote = incompleteGuidanceNote("bounded", {
      stoppedForWallTime,
      matchCount: 0,
    });
  } else if (stoppedForTopNProof && args.limit !== undefined) {
    userNote =
      `Top ${ranked.length} most recent matching candidates by Scout/note date. ` +
      `confirmedComplete=true (stopReason=complete): held ${args.limit} matches and every ` +
      `remaining unscanned open job is older than the ${args.limit}th match's note date ` +
      `(newest-first job walk). noteScan=candidate association — JobOrder.notes omit Scout Screen.`;
  } else if (incomplete && args.limit !== undefined && ranked.length > 0) {
    userNote =
      `Showing the ${ranked.length} most recent matching candidate(s) found while scanning open jobs ` +
      `(newest jobs first) in this department. ` +
      (jobsTruncated || stoppedForWallTime
        ? "More matches may exist on jobs not yet scanned — treat as a partial ranked list. "
        : "") +
      `stopReason=${stopReason}; confirmedComplete=false. Present these names. ` +
      INCOMPLETE_NO_FANOUT +
      (stoppedForWallTime ? ` ${ASYNC_CONTINUATION_HINT}` : "") +
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
      count: stoppedForTopNProof ? sortedRows.length : allJobIds.length,
      totalMatching: jobsTotal,
      truncated: incomplete && !stoppedForTopNProof ? jobsTruncated : false,
      pages,
      order: "dateAddedDesc",
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
      noteScanned,
      truncated: applicantsTruncated && !stoppedForTopNProof,
    },
    autoWiden: {
      elapsedMs: Date.now() - startedAt,
      wallMs,
      stoppedForWallTime,
      stoppedForTopNProof,
      noteScanPath: "candidate",
      rankedBy: "latestMatchingNoteDate",
      jobsOrderedBy: "dateAddedDesc",
      scanStrategy: "newest_job_pages_then_notes",
    },
    limits: {
      maxJobs: args.maxJobsCap,
      maxCandidatesToScan: args.maxCandidatesPerPage,
      wallMs,
    },
    stopReason,
    confirmedComplete,
    definition:
      "Natural-language Scout/screening report: resolve Internal Department nicknames, " +
      "preload OPEN jobs newest-first, page applicants + candidate notes " +
      "(Scout Screen lives on Candidate — not JobOrder.notes) with the given note action " +
      "(jobOrder or comment Job ID), rank by latest matching note date. " +
      "Pass limit=N for 'N most recent'. For applicantPool=responses, Top-N may confirm " +
      "complete early when remaining unscanned jobs are older than the Nth note; that " +
      "job-recency proof is disabled for applicantPool=all. Stop working only when " +
      "confirmedComplete=true or stopReason is a real connector/gateway limit — never " +
      "because of an arbitrary early search cap.",
    ...(incomplete && !confirmedComplete
      ? { incomplete: true, note: userNote }
      : { note: userNote }),
  };
}

/** High applicant budget for background snapshot sync (outside ChatGPT wall). */
export const SNAPSHOT_SYNC_MAX_CANDIDATES = 50_000;
export const SNAPSHOT_SYNC_MAX_JOBS = AUTO_WIDEN_MAX_JOBS;
/** Newest open jobs to re-scan live when serving from snapshot. */
export const SNAPSHOT_LIVE_TAIL_JOBS = AUTO_WIDEN_JOB_PAGE;

export type SnapshotNoteHit = {
  noteId: number;
  action: string;
  candidateId: number;
  jobId: number | null;
  department: string;
  noteDateAdded: number;
  candidateFirst?: string;
  candidateLast?: string;
  /** Candidate had a Response-bucket submission on a scanned open job. */
  responseApplicant: boolean;
};

/**
 * Walk open jobs → all applicants → allowlisted candidate notes for one department.
 * Tags each note with responseApplicant from Response-bucket submissions.
 * Used by the background snapshot sync (no ChatGPT wall).
 */
export async function harvestDepartmentSnapshotNotes(args: {
  department: string;
  isAllowlisted: (action: string) => boolean;
  maxJobs?: number;
  maxCandidates?: number;
}): Promise<{
  rows: SnapshotNoteHit[];
  complete: boolean;
  applicantPool: "all";
  jobsTotal: number;
  jobsLoaded: number;
  applicantsUnique: number;
  submissionRowsSeen: number;
  errorSummary?: string;
}> {
  const maxJobs = args.maxJobs ?? SNAPSHOT_SYNC_MAX_JOBS;
  const maxCandidates = args.maxCandidates ?? SNAPSHOT_SYNC_MAX_CANDIDATES;
  try {
    const jobs = await loadDepartmentJobs({
      department: args.department,
      openJobsOnly: true,
      maxJobs,
      pageAll: true,
    });
    if (jobs.jobIds.length === 0) {
      return {
        rows: [],
        complete: !jobs.jobsTruncated,
        applicantPool: "all",
        jobsTotal: jobs.jobsTotal,
        jobsLoaded: 0,
        applicantsUnique: 0,
        submissionRowsSeen: 0,
      };
    }
    const collected = await collectApplicantsForJobs({
      jobIds: jobs.jobIds,
      applicantPool: "all",
      maxCandidatesToScan: maxCandidates,
    });
    const jobIdSet = new Set(jobs.jobIds);
    const byNoteId = new Map<number, SnapshotNoteHit>();

    const applicants = [...collected.applicants.values()];
    for (const batch of chunk(applicants, NOTE_SCAN_CONCURRENCY)) {
      await mapWithLimit(batch, NOTE_SCAN_CONCURRENCY, async (app) => {
        const notesRes = (await getNotes({
          candidateId: app.candidateId,
          returnAllLoaded: true,
          fields:
            "id,action,comments,jobOrder,dateAdded,personReference,candidates",
        })) as { data?: Array<Record<string, unknown>> };
        const notes = Array.isArray(notesRes.data) ? notesRes.data : [];
        for (const note of notes) {
          const action = typeof note.action === "string" ? note.action : "";
          if (!args.isAllowlisted(action)) continue;
          const noteId = typeof note.id === "number" ? note.id : 0;
          if (!(noteId > 0)) continue;
          const dateAdded =
            typeof note.dateAdded === "number" ? note.dateAdded : 0;
          if (!(dateAdded > 0)) continue;
          const hitJobs = jobs.jobIds.filter((jid) =>
            noteReferencesJob(note, jid),
          );
          if (hitJobs.length === 0) continue;
          const primaryJob =
            hitJobs.find((jid) => jobIdSet.has(jid)) ?? hitJobs[0] ?? null;
          const fromNote =
            personName(note.personReference) || personName(note.candidates);
          byNoteId.set(noteId, {
            noteId,
            action,
            candidateId: app.candidateId,
            jobId: primaryJob,
            department: args.department,
            noteDateAdded: dateAdded,
            candidateFirst: app.firstName ?? fromNote.firstName,
            candidateLast: app.lastName ?? fromNote.lastName,
            responseApplicant: app.hadResponseSubmission === true,
          });
        }
      });
    }

    const complete =
      !jobs.jobsTruncated &&
      !collected.applicantsTruncated &&
      !collected.submissionDepthTruncated &&
      !collected.stoppedEarly;

    return {
      rows: [...byNoteId.values()],
      complete,
      applicantPool: "all",
      jobsTotal: jobs.jobsTotal,
      jobsLoaded: jobs.jobIds.length,
      applicantsUnique: collected.applicants.size,
      submissionRowsSeen: collected.submissionRowsSeen,
      ...(complete
        ? {}
        : {
            errorSummary: [
              jobs.jobsTruncated ? "jobs_truncated" : null,
              collected.applicantsTruncated ? "applicants_truncated" : null,
              collected.submissionDepthTruncated
                ? "submission_depth_truncated"
                : null,
            ]
              .filter(Boolean)
              .join(","),
          }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      rows: [],
      complete: false,
      applicantPool: "all",
      jobsTotal: 0,
      jobsLoaded: 0,
      applicantsUnique: 0,
      submissionRowsSeen: 0,
      errorSummary: msg.slice(0, 500),
    };
  }
}

/**
 * One newest-first job page association scan — live tail for snapshot reads.
 */
export async function liveTailScoutMatches(args: {
  department: string;
  noteAction: string;
  applicantPool?: ScoutApplicantPool;
  maxJobs?: number;
  maxCandidates?: number;
}): Promise<{
  matches: MatchCandidate[];
  stoppedForWallTime: boolean;
}> {
  const maxJobs = args.maxJobs ?? SNAPSHOT_LIVE_TAIL_JOBS;
  const maxCandidates =
    args.maxCandidates ?? AUTO_WIDEN_CANDIDATES_PER_PAGE;
  const applicantPool: ScoutApplicantPool =
    args.applicantPool === "all" ? "all" : "responses";
  const startedAt = Date.now();
  const wallMs = Math.min(TOPN_WALL_MS, 25_000);
  const wallHit = () => Date.now() - startedAt >= wallMs;

  const preloaded = await loadDepartmentJobs({
    department: args.department,
    openJobsOnly: true,
    maxJobs: SNAPSHOT_SYNC_MAX_JOBS,
    pageAll: true,
  });
  const sortedRows = sortJobsNewestFirst(preloaded.jobRows).slice(0, maxJobs);
  if (sortedRows.length === 0) {
    return { matches: [], stoppedForWallTime: false };
  }
  const batch = jobsBundleFromRows(sortedRows, preloaded.jobsTotal, false);
  const collected = await collectApplicantsForJobs({
    jobIds: batch.jobIds,
    applicantPool,
    maxCandidatesToScan: maxCandidates,
    shouldStop: wallHit,
  });
  let stoppedForWallTime = collected.stoppedEarly && wallHit();
  const noteScan = await matchApplicantsByCandidateNotes({
    applicants: [...collected.applicants.values()],
    noteAction: args.noteAction,
    departmentJobIds: preloaded.jobIds,
    jobTitleById: preloaded.jobTitleById,
    shouldStop: () => {
      if (wallHit()) {
        stoppedForWallTime = true;
        return true;
      }
      return false;
    },
  });
  if (noteScan.stoppedEarly && wallHit()) stoppedForWallTime = true;
  return { matches: noteScan.matches, stoppedForWallTime };
}

/** Re-export for tests that assert comment parsing stays wired. */
export { parseJobIdsFromNoteComments, noteReferencesJob };
