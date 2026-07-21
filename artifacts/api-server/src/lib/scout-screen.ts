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
 */
import {
  searchJobs,
  searchAnyEntity,
  getNotes,
  noteReferencesJob,
  parseJobIdsFromNoteComments,
} from "./bullhorn-client.js";
import { classifySubmissionStage } from "./submission-status.js";

const DEFAULT_NOTE_ACTION = "Scout Screen - Qualified";
const DEFAULT_MAX_JOBS = 25;
const HARD_MAX_JOBS = 100;
const DEFAULT_MAX_CANDIDATES = 100;
const HARD_MAX_CANDIDATES = 400;
const JOB_ID_BATCH = 20;
const NOTE_SCAN_CONCURRENCY = 4;
const SUBMISSION_PAGE = 50;

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

export async function scoutQualifiedByDepartment(args: {
  department: string;
  noteAction?: string;
  openJobsOnly?: boolean;
  /** Default "responses" = Bullhorn Response tab (New Lead / Online Applicant). */
  applicantPool?: ScoutApplicantPool;
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
  const maxJobs = Math.min(
    Math.max(args.maxJobs ?? DEFAULT_MAX_JOBS, 1),
    HARD_MAX_JOBS,
  );
  const maxCandidatesToScan = Math.min(
    Math.max(args.maxCandidatesToScan ?? DEFAULT_MAX_CANDIDATES, 1),
    HARD_MAX_CANDIDATES,
  );

  const jobsQuery = buildDepartmentJobsQuery(department, openJobsOnly);
  const jobsRes = (await searchJobs({
    query: jobsQuery,
    fields: "id,title,status,isOpen,correlatedCustomText1,dateAdded",
    count: maxJobs,
    start: 0,
  })) as {
    total?: number;
    data?: Array<Record<string, unknown>>;
  };
  const jobRows = Array.isArray(jobsRes.data) ? jobsRes.data : [];
  const jobsTotal = typeof jobsRes.total === "number" ? jobsRes.total : jobRows.length;
  const jobsTruncated = jobsTotal > jobRows.length;
  const jobIds = jobRows
    .map((r) => (typeof r.id === "number" ? r.id : null))
    .filter((id): id is number => id !== null);
  const jobIdSet = new Set(jobIds);
  const jobTitleById = new Map<number, string>();
  for (const r of jobRows) {
    if (typeof r.id === "number" && typeof r.title === "string") {
      jobTitleById.set(r.id, r.title);
    }
  }

  if (jobIds.length === 0) {
    return {
      department,
      noteAction,
      openJobsOnly,
      applicantPool,
      uniqueCandidateCount: 0,
      candidates: [],
      jobsScanned: { count: 0, totalMatching: jobsTotal, truncated: false },
      applicantsScanned: { uniqueCandidates: 0, truncated: false },
      limits: { maxJobs, maxCandidatesToScan },
      definition:
        "Jobs by Internal Department (correlatedCustomText1) → inbound applicants " +
        "(JobSubmission Response bucket by default) → candidate notes with matching action " +
        "that reference a scanned job (jobOrder or comment Job ID).",
      note: `No jobs found for department "${department}" with the current filters.`,
    };
  }

  // Collect unique applicants across department jobs (batched Lucene on jobOrder.id).
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
    applicantPool === "responses"
      ? ` AND (status:"New Lead" OR status:"Online Applicant")`
      : "";
  const dateClauseParts: string[] = [];
  // Optional JobSubmission dateAdded window (Lucene epoch ms). Keep light — callers
  // usually want "who applied to these dept jobs" without a tight window.
  if (args.dateAddedStart || args.dateAddedEnd) {
    // Reuse getNotes date parsing via a tiny local parse to avoid exporting internals.
    const startMs = args.dateAddedStart
      ? Date.parse(
          /^\d{4}-\d{2}-\d{2}$/.test(args.dateAddedStart.trim())
            ? `${args.dateAddedStart.trim()}T00:00:00.000Z`
            : args.dateAddedStart,
        )
      : undefined;
    const endMs = args.dateAddedEnd
      ? Date.parse(
          /^\d{4}-\d{2}-\d{2}$/.test(args.dateAddedEnd.trim())
            ? `${args.dateAddedEnd.trim()}T00:00:00.000Z`
            : args.dateAddedEnd,
        )
      : undefined;
    if (startMs !== undefined && Number.isNaN(startMs)) {
      throw new Error(`Invalid dateAddedStart "${args.dateAddedStart}"`);
    }
    if (endMs !== undefined && Number.isNaN(endMs)) {
      throw new Error(`Invalid dateAddedEnd "${args.dateAddedEnd}"`);
    }
    const lo = startMs !== undefined ? String(startMs) : "*";
    const hi = endMs !== undefined ? String(endMs - 1) : "*";
    dateClauseParts.push(` AND dateAdded:[${lo} TO ${hi}]`);
  }
  const dateClause = dateClauseParts.join("");

  for (const batch of chunk(jobIds, JOB_ID_BATCH)) {
    if (applicants.size >= maxCandidatesToScan) {
      applicantsTruncated = true;
      break;
    }
    const idClause = batch.join(" OR ");
    let start = 0;
    for (;;) {
      if (applicants.size >= maxCandidatesToScan) {
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
          applicantPool === "responses" &&
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
          if (applicants.size >= maxCandidatesToScan) {
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
      // Safety cap per batch to avoid runaway paging on huge jobs.
      if (start >= 500) {
        applicantsTruncated = true;
        break;
      }
    }
  }

  const applicantList = [...applicants.values()];
  const jobIdsArr = [...jobIdSet];

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
      if (action !== noteAction) continue;
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

  // Attach bullhornUrl via a cheap pattern — enrichWithProfileUrls needs a session
  // host; getNotes / search already return URLs on submissions. Fetch one candidate
  // page through searchAnyEntity for URLs when we have matches.
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

  const incomplete = jobsTruncated || applicantsTruncated;
  return {
    department,
    noteAction,
    openJobsOnly,
    applicantPool,
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
      uniqueCandidates: applicantList.length,
      submissionRowsSeen,
      truncated: applicantsTruncated,
    },
    limits: { maxJobs, maxCandidatesToScan },
    definition:
      "1) JobOrder Internal Department = correlatedCustomText1 (exact). " +
      "2) Applicant pool = JobSubmission Response statuses (New Lead / Online Applicant) by default — not recruiter submissions. " +
      `3) Notes loaded per candidate; keep action exactly "${noteAction}" that reference a scanned job via jobOrder or comment "Job ID: N". ` +
      "4) Return UNIQUE candidates. Global Note Lucene search is unavailable on this instance.",
    ...(incomplete
      ? {
          incomplete: true,
          note:
            "Result set may be incomplete because job and/or applicant caps were hit. " +
            "Raise maxJobs / maxCandidatesToScan, set openJobsOnly, or narrow with dateAddedStart/dateAddedEnd. " +
            "Do NOT treat uniqueCandidateCount as the firm-wide total of all such notes.",
        }
      : {
          note:
            "Unique candidates among the scanned applicant pool for this department. " +
            "Not a firm-wide Note Lucene count (Note search index returns 0 on this Bullhorn instance).",
        }),
  };
}

/** Re-export for tests that assert comment parsing stays wired. */
export { parseJobIdsFromNoteComments, noteReferencesJob };
