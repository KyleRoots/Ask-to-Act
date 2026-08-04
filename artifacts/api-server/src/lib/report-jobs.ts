/**
 * In-process async report jobs (mirror note-snapshot sync 202 pattern).
 * Persist row → return jobId → void run() with firm Bullhorn context.
 * No Redis / BullMQ. Shared across scout, match, recruiter_leaderboard, …
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, reportJobsTable } from "@workspace/db";
import { firmContext, currentFirmContextId } from "./bullhorn-auth.js";
import { logger } from "./logger.js";
import {
  ASYNC_REPORT_WALL_MS,
  scoutQualifiedByDepartment,
  scoutReportQuerySchema,
} from "./scout-screen.js";
import {
  matchCandidatesForJob,
  matchCandidatesArgsSchema,
} from "./matching.js";
import {
  recruiterLeaderboard,
  recruiterLeaderboardArgsSchema,
} from "./reports.js";

export const SCOUT_DEPT_REPORT_TOOL = "scout_dept_report";
export const MATCH_CANDIDATES_TOOL = "match_candidates_for_job";
export const RECRUITER_LEADERBOARD_TOOL = "recruiter_leaderboard";

export type ScoutReportJobArgs = z.infer<typeof scoutReportQuerySchema>;
export type MatchCandidatesJobArgs = z.infer<typeof matchCandidatesArgsSchema>;
export type RecruiterLeaderboardJobArgs = z.infer<
  typeof recruiterLeaderboardArgsSchema
>;

export type ReportJobStatus = "queued" | "running" | "complete" | "failed";

/** In-memory firm-scoped locks: firmId → Set of running job ids / dedupe keys. */
const runningByFirm = new Map<string, Set<string>>();
const dedupeInFlight = new Set<string>();

function firmRunningSet(firmId: string): Set<string> {
  let s = runningByFirm.get(firmId);
  if (!s) {
    s = new Set();
    runningByFirm.set(firmId, s);
  }
  return s;
}

function stopReasonFromResult(result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const sr = (result as { stopReason?: unknown }).stopReason;
  return typeof sr === "string" ? sr : null;
}

/**
 * PostgreSQL jsonb/text reject U+0000. Résumé excerpts (and similar ATS text)
 * can contain null bytes from PDF/DOC extraction — strip before persist.
 */
export function sanitizeJsonForPostgres<T>(value: T): T {
  if (typeof value === "string") {
    return (value.includes("\u0000") ? value.replaceAll("\u0000", "") : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonForPostgres(item)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeJsonForPostgres(v);
    }
    return out as T;
  }
  return value;
}

export type StartReportJobResult =
  | { jobId: string; status: "queued"; deduped?: false }
  | {
      jobId: string;
      status: ReportJobStatus;
      deduped: true;
      message: string;
    };

/** Stable fingerprint for firm-scoped dedupe of identical in-flight scout jobs. */
export function scoutJobDedupeKey(
  firmId: string,
  args: ScoutReportJobArgs,
): string {
  const normalized = {
    department: args.department.trim().toLowerCase(),
    noteAction: (args.noteAction ?? "Scout Screen - Qualified").trim(),
    openJobsOnly: args.openJobsOnly !== false,
    applicantPool: args.applicantPool === "all" ? "all" : "responses",
    mode: args.mode === "exhaustive" ? "exhaustive" : "bounded",
    limit: args.limit ?? null,
    maxJobs: args.maxJobs ?? null,
    maxCandidatesToScan: args.maxCandidatesToScan ?? null,
    dateAddedStart: args.dateAddedStart ?? null,
    dateAddedEnd: args.dateAddedEnd ?? null,
  };
  return `${firmId}:scout_dept_report:${JSON.stringify(normalized)}`;
}

export function matchCandidatesJobDedupeKey(
  firmId: string,
  args: MatchCandidatesJobArgs,
): string {
  const normalized = {
    jobId: args.jobId,
    mustHaveSkills: args.mustHaveSkills ?? null,
    niceToHaveSkills: args.niceToHaveSkills ?? null,
    limit: args.limit ?? null,
    poolSize: args.poolSize ?? null,
    localOnly: !!args.localOnly,
    includePlaced: !!args.includePlaced,
    includeSubmitted: !!args.includeSubmitted,
    includeDoNotContact: !!args.includeDoNotContact,
    includeInactive: !!args.includeInactive,
  };
  return `${firmId}:match_candidates_for_job:${JSON.stringify(normalized)}`;
}

export function recruiterLeaderboardJobDedupeKey(
  firmId: string,
  args: RecruiterLeaderboardJobArgs,
): string {
  const normalized = {
    startDate: args.startDate ?? null,
    endDate: args.endDate ?? null,
  };
  return `${firmId}:recruiter_leaderboard:${JSON.stringify(normalized)}`;
}

/**
 * Generic persist → 202 → in-process execute for any report_jobs tool_name.
 */
export async function startReportJob(opts: {
  firmId: string;
  toolName: string;
  args: Record<string, unknown>;
  createdByUserId?: string | null;
  dedupeKey: string;
  dedupeMessage: string;
  findActive: () => Promise<{ id: string; status: string } | null>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}): Promise<StartReportJobResult> {
  if (dedupeInFlight.has(opts.dedupeKey)) {
    const existing = await opts.findActive();
    if (existing) {
      return {
        jobId: existing.id,
        status: existing.status as ReportJobStatus,
        deduped: true,
        message: opts.dedupeMessage,
      };
    }
  }

  const existing = await opts.findActive();
  if (existing) {
    return {
      jobId: existing.id,
      status: existing.status as ReportJobStatus,
      deduped: true,
      message: opts.dedupeMessage,
    };
  }

  const jobId = randomUUID();
  await db.insert(reportJobsTable).values({
    id: jobId,
    firmId: opts.firmId,
    toolName: opts.toolName,
    args: opts.args,
    status: "queued",
    createdByUserId: opts.createdByUserId ?? null,
  });

  dedupeInFlight.add(opts.dedupeKey);
  firmRunningSet(opts.firmId).add(jobId);

  void executeReportJob({
    jobId,
    firmId: opts.firmId,
    toolName: opts.toolName,
    args: opts.args,
    dedupeKey: opts.dedupeKey,
    execute: opts.execute,
  });

  return { jobId, status: "queued" };
}

async function executeReportJob(opts: {
  jobId: string;
  firmId: string;
  toolName: string;
  args: Record<string, unknown>;
  dedupeKey: string;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}): Promise<void> {
  try {
    await db
      .update(reportJobsTable)
      .set({ status: "running", startedAt: new Date() })
      .where(
        and(
          eq(reportJobsTable.id, opts.jobId),
          eq(reportJobsTable.firmId, opts.firmId),
        ),
      );

    const result = await firmContext.run({ firmId: opts.firmId }, () =>
      opts.execute(opts.args),
    );
    const persistable = sanitizeJsonForPostgres(result);

    await db
      .update(reportJobsTable)
      .set({
        status: "complete",
        result: persistable,
        stopReason: stopReasonFromResult(persistable),
        finishedAt: new Date(),
        errorSummary: null,
      })
      .where(
        and(
          eq(reportJobsTable.id, opts.jobId),
          eq(reportJobsTable.firmId, opts.firmId),
        ),
      );

    logger.info(
      {
        jobId: opts.jobId,
        firmId: opts.firmId,
        toolName: opts.toolName,
        stopReason: stopReasonFromResult(persistable),
      },
      "Async report job complete",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      {
        jobId: opts.jobId,
        firmId: opts.firmId,
        toolName: opts.toolName,
        err,
      },
      "Async report job failed",
    );
    try {
      await db
        .update(reportJobsTable)
        .set({
          status: "failed",
          errorSummary: sanitizeJsonForPostgres(msg).slice(0, 2000),
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(reportJobsTable.id, opts.jobId),
            eq(reportJobsTable.firmId, opts.firmId),
          ),
        );
    } catch (updateErr) {
      logger.error(
        { jobId: opts.jobId, firmId: opts.firmId, err: updateErr },
        "Failed to persist report job failure",
      );
    }
  } finally {
    dedupeInFlight.delete(opts.dedupeKey);
    firmRunningSet(opts.firmId).delete(opts.jobId);
  }
}

async function findActiveJobByDedupe(opts: {
  firmId: string;
  toolName: string;
  dedupeKey: string;
  argsKey: (firmId: string, args: unknown) => string | null;
}): Promise<{ id: string; status: string } | null> {
  const rows = await db
    .select({
      id: reportJobsTable.id,
      status: reportJobsTable.status,
      args: reportJobsTable.args,
    })
    .from(reportJobsTable)
    .where(
      and(
        eq(reportJobsTable.firmId, opts.firmId),
        eq(reportJobsTable.toolName, opts.toolName),
        inArray(reportJobsTable.status, ["queued", "running"]),
      ),
    );

  for (const row of rows) {
    const key = opts.argsKey(opts.firmId, row.args);
    if (key === opts.dedupeKey) {
      return { id: row.id, status: row.status };
    }
  }
  return null;
}

/**
 * Persist a scout_dept_report job and start it in-process (HTTP 202 pattern).
 * Firm-scoped: identical args already queued/running return that job id.
 */
export async function startScoutDeptReportJob(opts: {
  firmId: string;
  args: ScoutReportJobArgs;
  createdByUserId?: string | null;
}): Promise<StartReportJobResult> {
  const parsed = scoutReportQuerySchema.parse(opts.args);
  const dedupeKey = scoutJobDedupeKey(opts.firmId, parsed);
  return startReportJob({
    firmId: opts.firmId,
    toolName: SCOUT_DEPT_REPORT_TOOL,
    args: parsed,
    createdByUserId: opts.createdByUserId,
    dedupeKey,
    dedupeMessage:
      "An identical scout_dept_report job is already queued or running for this firm.",
    findActive: () =>
      findActiveJobByDedupe({
        firmId: opts.firmId,
        toolName: SCOUT_DEPT_REPORT_TOOL,
        dedupeKey,
        argsKey: (firmId, raw) => {
          const rowArgs = scoutReportQuerySchema.safeParse(raw);
          if (!rowArgs.success) return null;
          return scoutJobDedupeKey(firmId, rowArgs.data);
        },
      }),
    execute: (args) =>
      scoutQualifiedByDepartment({
        ...(args as ScoutReportJobArgs),
        wallMs: ASYNC_REPORT_WALL_MS,
      }),
  });
}

/** Async match_candidates_for_job beyond the sync soft wall. */
export async function startMatchCandidatesJob(opts: {
  firmId: string;
  args: MatchCandidatesJobArgs;
  createdByUserId?: string | null;
}): Promise<StartReportJobResult> {
  const parsed = matchCandidatesArgsSchema.parse(opts.args);
  const dedupeKey = matchCandidatesJobDedupeKey(opts.firmId, parsed);
  return startReportJob({
    firmId: opts.firmId,
    toolName: MATCH_CANDIDATES_TOOL,
    args: parsed,
    createdByUserId: opts.createdByUserId,
    dedupeKey,
    dedupeMessage:
      "An identical match_candidates_for_job job is already queued or running for this firm.",
    findActive: () =>
      findActiveJobByDedupe({
        firmId: opts.firmId,
        toolName: MATCH_CANDIDATES_TOOL,
        dedupeKey,
        argsKey: (firmId, raw) => {
          const rowArgs = matchCandidatesArgsSchema.safeParse(raw);
          if (!rowArgs.success) return null;
          return matchCandidatesJobDedupeKey(firmId, rowArgs.data);
        },
      }),
    execute: (args) =>
      matchCandidatesForJob({
        ...(args as MatchCandidatesJobArgs),
        wallMs: ASYNC_REPORT_WALL_MS,
      }),
  });
}

/** Async recruiter_leaderboard beyond the sync soft wall. */
export async function startRecruiterLeaderboardJob(opts: {
  firmId: string;
  args: RecruiterLeaderboardJobArgs;
  createdByUserId?: string | null;
}): Promise<StartReportJobResult> {
  const parsed = recruiterLeaderboardArgsSchema.parse(opts.args);
  const dedupeKey = recruiterLeaderboardJobDedupeKey(opts.firmId, parsed);
  return startReportJob({
    firmId: opts.firmId,
    toolName: RECRUITER_LEADERBOARD_TOOL,
    args: parsed,
    createdByUserId: opts.createdByUserId,
    dedupeKey,
    dedupeMessage:
      "An identical recruiter_leaderboard job is already queued or running for this firm.",
    findActive: () =>
      findActiveJobByDedupe({
        firmId: opts.firmId,
        toolName: RECRUITER_LEADERBOARD_TOOL,
        dedupeKey,
        argsKey: (firmId, raw) => {
          const rowArgs = recruiterLeaderboardArgsSchema.safeParse(raw);
          if (!rowArgs.success) return null;
          return recruiterLeaderboardJobDedupeKey(firmId, rowArgs.data);
        },
      }),
    execute: (args) =>
      recruiterLeaderboard({
        ...(args as RecruiterLeaderboardJobArgs),
        wallMs: ASYNC_REPORT_WALL_MS,
      }),
  });
}

export type ReportJobView = {
  jobId: string;
  firmId: string;
  toolName: string;
  status: ReportJobStatus;
  args: unknown;
  result?: unknown;
  errorSummary?: string | null;
  stopReason?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
};

/**
 * Firm-scoped job lookup. Returns null when missing or wrong firm
 * (callers should 404 — never leak cross-tenant existence).
 */
export async function getReportJob(opts: {
  jobId: string;
  firmId: string;
}): Promise<ReportJobView | null> {
  const [row] = await db
    .select()
    .from(reportJobsTable)
    .where(
      and(
        eq(reportJobsTable.id, opts.jobId),
        eq(reportJobsTable.firmId, opts.firmId),
      ),
    )
    .limit(1);

  if (!row) return null;

  return {
    jobId: row.id,
    firmId: row.firmId,
    toolName: row.toolName,
    status: row.status as ReportJobStatus,
    args: row.args,
    ...(row.status === "complete" && row.result !== null
      ? { result: row.result }
      : {}),
    ...(row.errorSummary != null ? { errorSummary: row.errorSummary } : {}),
    ...(row.stopReason != null ? { stopReason: row.stopReason } : {}),
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

/** Resolve firm id from ALS (MCP / v1 user callers). */
export function requireFirmIdForReportJobs(): string {
  const firmId = currentFirmContextId();
  if (!firmId) {
    throw new Error(
      "Report jobs require a firm Bullhorn context (enrolled user API key).",
    );
  }
  return firmId;
}

/** Test helper: clear in-memory locks. */
export function __resetReportJobLocksForTests(): void {
  runningByFirm.clear();
  dedupeInFlight.clear();
}

/** @deprecated alias — prefer StartReportJobResult */
export type StartScoutJobResult = StartReportJobResult;
