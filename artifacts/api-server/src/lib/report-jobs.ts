/**
 * Durable async report jobs (DB lease + in-process poller).
 * Persist queued → return jobId → worker claims/runs with heartbeat.
 * Redeploy reclaim: stale running leases become claimable again.
 * No Redis / BullMQ. Shared across scout, match, recruiter_leaderboard, …
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
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

/** Soft lease TTL; stale running jobs are reclaimable after this. */
export const REPORT_JOB_LEASE_TTL_MS = 120_000;
/** Heartbeat interval while a job runs (must be < lease TTL). */
export const REPORT_JOB_HEARTBEAT_MS = 30_000;
/** Poller tick when idle. */
export const REPORT_JOB_POLL_MS = 2_000;
/** Cap concurrent jobs per process (API latency safety). */
export const REPORT_JOB_MAX_CONCURRENT = Math.max(
  1,
  Number.parseInt(process.env["REPORT_JOB_CONCURRENCY"] ?? "2", 10) || 2,
);
/** After this many claims (including reclaim), mark failed. */
export const REPORT_JOB_MAX_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env["REPORT_JOB_MAX_ATTEMPTS"] ?? "5", 10) || 5,
);

/** In-memory firm-scoped dedupe of concurrent identical starts. */
const dedupeInFlight = new Set<string>();

/** Optional wake hook set by the worker poller. */
let wakeWorker: (() => void) | null = null;

export function setReportJobWorkerWake(fn: (() => void) | null): void {
  wakeWorker = fn;
}

function kickWorker(): void {
  try {
    wakeWorker?.();
  } catch {
    // ignore wake errors
  }
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

export type ReportJobRunner = (
  args: Record<string, unknown>,
) => Promise<unknown>;

/** Tool runners used by the durable worker (no request-scoped closures). */
export const REPORT_JOB_RUNNERS: Record<string, ReportJobRunner> = {
  [SCOUT_DEPT_REPORT_TOOL]: (args) =>
    scoutQualifiedByDepartment({
      ...(args as ScoutReportJobArgs),
      wallMs: ASYNC_REPORT_WALL_MS,
    }),
  [MATCH_CANDIDATES_TOOL]: (args) =>
    matchCandidatesForJob({
      ...(args as MatchCandidatesJobArgs),
      wallMs: ASYNC_REPORT_WALL_MS,
    }),
  [RECRUITER_LEADERBOARD_TOOL]: (args) =>
    recruiterLeaderboard({
      ...(args as RecruiterLeaderboardJobArgs),
      wallMs: ASYNC_REPORT_WALL_MS,
    }),
};

export function getReportJobRunner(toolName: string): ReportJobRunner | null {
  return REPORT_JOB_RUNNERS[toolName] ?? null;
}

/**
 * Whether a row is eligible for claim (queued, or running with expired lease).
 * Pure helper for unit tests — mirrors the SQL claim predicate.
 */
export function isReportJobClaimable(opts: {
  status: string;
  leaseExpiresAt: Date | string | null | undefined;
  now?: Date;
}): boolean {
  if (opts.status === "queued") return true;
  if (opts.status !== "running") return false;
  if (opts.leaseExpiresAt == null) {
    // Pre-lease running rows (legacy in-process) are reclaimable immediately.
    return true;
  }
  const expires =
    opts.leaseExpiresAt instanceof Date
      ? opts.leaseExpiresAt
      : new Date(opts.leaseExpiresAt);
  if (Number.isNaN(expires.getTime())) return true;
  return expires.getTime() < (opts.now ?? new Date()).getTime();
}

export type ClaimedReportJob = {
  id: string;
  firmId: string;
  toolName: string;
  args: unknown;
  status: string;
  attemptCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  startedAt: Date | null;
};

/**
 * Atomically claim one queued or stale-running job for this worker.
 * Uses FOR UPDATE SKIP LOCKED so concurrent API instances do not double-run.
 */
export async function claimNextReportJob(opts: {
  leaseOwner: string;
  leaseTtlMs?: number;
  maxAttempts?: number;
}): Promise<ClaimedReportJob | null> {
  const leaseTtlMs = opts.leaseTtlMs ?? REPORT_JOB_LEASE_TTL_MS;
  const maxAttempts = opts.maxAttempts ?? REPORT_JOB_MAX_ATTEMPTS;
  const leaseMs = Math.max(5_000, leaseTtlMs);

  // Fail jobs that have been claimed too many times (poison / perpetual crash).
  await db.execute(sql`
    UPDATE report_jobs
    SET
      status = 'failed',
      error_summary = ${`Exceeded max attempts (${maxAttempts}) after lease reclaim`},
      finished_at = NOW(),
      lease_owner = NULL,
      lease_expires_at = NULL
    WHERE id IN (
      SELECT id FROM report_jobs
      WHERE
        status = 'running'
        AND attempt_count >= ${maxAttempts}
        AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
      FOR UPDATE SKIP LOCKED
      LIMIT 20
    )
  `);

  const result = await db.execute(sql`
    WITH cte AS (
      SELECT id
      FROM report_jobs
      WHERE
        status = 'queued'
        OR (
          status = 'running'
          AND attempt_count < ${maxAttempts}
          AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
        )
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE report_jobs j
    SET
      status = 'running',
      lease_owner = ${opts.leaseOwner},
      lease_expires_at = NOW() + (${leaseMs}::text || ' milliseconds')::interval,
      heartbeat_at = NOW(),
      started_at = COALESCE(j.started_at, NOW()),
      attempt_count = j.attempt_count + 1,
      error_summary = NULL,
      finished_at = NULL
    FROM cte
    WHERE j.id = cte.id
    RETURNING
      j.id,
      j.firm_id AS "firmId",
      j.tool_name AS "toolName",
      j.args,
      j.status,
      j.attempt_count AS "attemptCount",
      j.lease_owner AS "leaseOwner",
      j.lease_expires_at AS "leaseExpiresAt",
      j.started_at AS "startedAt"
  `);

  const row = result.rows[0] as
    | {
        id: string;
        firmId: string;
        toolName: string;
        args: unknown;
        status: string;
        attemptCount: number;
        leaseOwner: string | null;
        leaseExpiresAt: Date | string | null;
        startedAt: Date | string | null;
      }
    | undefined;

  if (!row) return null;

  return {
    id: row.id,
    firmId: row.firmId,
    toolName: row.toolName,
    args: row.args,
    status: row.status,
    attemptCount: Number(row.attemptCount),
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt
      ? new Date(row.leaseExpiresAt)
      : null,
    startedAt: row.startedAt ? new Date(row.startedAt) : null,
  };
}

/** Extend lease while the job is still running under this owner. */
export async function heartbeatReportJob(opts: {
  jobId: string;
  leaseOwner: string;
  leaseTtlMs?: number;
}): Promise<boolean> {
  const leaseMs = Math.max(5_000, opts.leaseTtlMs ?? REPORT_JOB_LEASE_TTL_MS);
  const result = await db.execute(sql`
    UPDATE report_jobs
    SET
      heartbeat_at = NOW(),
      lease_expires_at = NOW() + (${leaseMs}::text || ' milliseconds')::interval
    WHERE
      id = ${opts.jobId}
      AND status = 'running'
      AND lease_owner = ${opts.leaseOwner}
    RETURNING id
  `);
  return (result.rows?.length ?? 0) > 0;
}

export async function completeReportJob(opts: {
  jobId: string;
  firmId: string;
  leaseOwner: string;
  result: unknown;
}): Promise<boolean> {
  const persistable = sanitizeJsonForPostgres(opts.result);
  const updated = await db
    .update(reportJobsTable)
    .set({
      status: "complete",
      result: persistable,
      stopReason: stopReasonFromResult(persistable),
      finishedAt: new Date(),
      errorSummary: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: new Date(),
    })
    .where(
      and(
        eq(reportJobsTable.id, opts.jobId),
        eq(reportJobsTable.firmId, opts.firmId),
        eq(reportJobsTable.leaseOwner, opts.leaseOwner),
      ),
    )
    .returning({ id: reportJobsTable.id });
  return updated.length > 0;
}

export async function failReportJob(opts: {
  jobId: string;
  firmId: string;
  leaseOwner: string;
  error: string;
}): Promise<boolean> {
  const updated = await db
    .update(reportJobsTable)
    .set({
      status: "failed",
      errorSummary: sanitizeJsonForPostgres(opts.error).slice(0, 2000),
      finishedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: new Date(),
    })
    .where(
      and(
        eq(reportJobsTable.id, opts.jobId),
        eq(reportJobsTable.firmId, opts.firmId),
        eq(reportJobsTable.leaseOwner, opts.leaseOwner),
      ),
    )
    .returning({ id: reportJobsTable.id });
  return updated.length > 0;
}

/**
 * Run a claimed job under firm Bullhorn context with lease heartbeats.
 */
export async function runClaimedReportJob(opts: {
  job: ClaimedReportJob;
  leaseOwner: string;
  leaseTtlMs?: number;
  heartbeatMs?: number;
}): Promise<"complete" | "failed"> {
  const runner = getReportJobRunner(opts.job.toolName);
  if (!runner) {
    const msg = `Unknown report job tool_name: ${opts.job.toolName}`;
    logger.error(
      { jobId: opts.job.id, toolName: opts.job.toolName },
      msg,
    );
    await failReportJob({
      jobId: opts.job.id,
      firmId: opts.job.firmId,
      leaseOwner: opts.leaseOwner,
      error: msg,
    });
    return "failed";
  }

  const args =
    opts.job.args && typeof opts.job.args === "object"
      ? (opts.job.args as Record<string, unknown>)
      : {};

  const heartbeatMs = opts.heartbeatMs ?? REPORT_JOB_HEARTBEAT_MS;
  const leaseTtlMs = opts.leaseTtlMs ?? REPORT_JOB_LEASE_TTL_MS;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  heartbeatTimer = setInterval(() => {
    void heartbeatReportJob({
      jobId: opts.job.id,
      leaseOwner: opts.leaseOwner,
      leaseTtlMs,
    }).then((ok) => {
      if (!ok) {
        logger.warn(
          { jobId: opts.job.id, leaseOwner: opts.leaseOwner },
          "Report job heartbeat lost lease",
        );
      }
    });
  }, heartbeatMs);
  // Don't keep the process alive solely for heartbeats.
  if (typeof heartbeatTimer.unref === "function") {
    heartbeatTimer.unref();
  }

  try {
    logger.info(
      {
        jobId: opts.job.id,
        firmId: opts.job.firmId,
        toolName: opts.job.toolName,
        attemptCount: opts.job.attemptCount,
        leaseOwner: opts.leaseOwner,
      },
      "Async report job claimed — running",
    );

    const result = await firmContext.run({ firmId: opts.job.firmId }, () =>
      runner(args),
    );

    const saved = await completeReportJob({
      jobId: opts.job.id,
      firmId: opts.job.firmId,
      leaseOwner: opts.leaseOwner,
      result,
    });
    if (!saved) {
      logger.warn(
        {
          jobId: opts.job.id,
          firmId: opts.job.firmId,
          leaseOwner: opts.leaseOwner,
        },
        "Async report job complete skipped — lease lost (reclaimed)",
      );
      return "failed";
    }

    logger.info(
      {
        jobId: opts.job.id,
        firmId: opts.job.firmId,
        toolName: opts.job.toolName,
        stopReason: stopReasonFromResult(result),
        attemptCount: opts.job.attemptCount,
      },
      "Async report job complete",
    );
    return "complete";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      {
        jobId: opts.job.id,
        firmId: opts.job.firmId,
        toolName: opts.job.toolName,
        attemptCount: opts.job.attemptCount,
        err,
      },
      "Async report job failed",
    );
    try {
      const saved = await failReportJob({
        jobId: opts.job.id,
        firmId: opts.job.firmId,
        leaseOwner: opts.leaseOwner,
        error: msg,
      });
      if (!saved) {
        logger.warn(
          {
            jobId: opts.job.id,
            firmId: opts.job.firmId,
            leaseOwner: opts.leaseOwner,
          },
          "Async report job fail persist skipped — lease lost (reclaimed)",
        );
      }
    } catch (updateErr) {
      logger.error(
        { jobId: opts.job.id, firmId: opts.job.firmId, err: updateErr },
        "Failed to persist report job failure",
      );
    }
    return "failed";
  } finally {
    stopHeartbeat();
  }
}

/**
 * Persist a report job as queued and wake the durable worker.
 * Execution is claim-based — survives API redeploy/restart.
 */
export async function startReportJob(opts: {
  firmId: string;
  toolName: string;
  args: Record<string, unknown>;
  createdByUserId?: string | null;
  dedupeKey: string;
  dedupeMessage: string;
  findActive: () => Promise<{ id: string; status: string } | null>;
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

  if (!getReportJobRunner(opts.toolName)) {
    throw new Error(`No runner registered for tool_name: ${opts.toolName}`);
  }

  const jobId = randomUUID();
  await db.insert(reportJobsTable).values({
    id: jobId,
    firmId: opts.firmId,
    toolName: opts.toolName,
    args: opts.args,
    status: "queued",
    createdByUserId: opts.createdByUserId ?? null,
    attemptCount: 0,
  });

  dedupeInFlight.add(opts.dedupeKey);
  // Release in-memory dedupe shortly; DB queued/running is source of truth.
  setTimeout(() => dedupeInFlight.delete(opts.dedupeKey), 5_000).unref?.();

  logger.info(
    { jobId, firmId: opts.firmId, toolName: opts.toolName },
    "Async report job queued",
  );
  kickWorker();

  return { jobId, status: "queued" };
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
 * Persist a scout_dept_report job (HTTP 202 pattern).
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

/** Test helper: clear in-memory dedupe locks. */
export function __resetReportJobLocksForTests(): void {
  dedupeInFlight.clear();
}

/** @deprecated alias — prefer StartReportJobResult */
export type StartScoutJobResult = StartReportJobResult;
