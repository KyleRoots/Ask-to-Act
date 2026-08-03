/**
 * In-process async report jobs (mirror note-snapshot sync 202 pattern).
 * Persist row → return jobId → void run() with firm Bullhorn context.
 * No Redis / BullMQ.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, reportJobsTable } from "@workspace/db";
import { firmContext, currentFirmContextId } from "./bullhorn-auth.js";
import { logger } from "./logger.js";
import {
  ASYNC_REPORT_WALL_MS,
  scoutQualifiedByDepartment,
  scoutReportQuerySchema,
} from "./scout-screen.js";
import type { z } from "zod";

export const SCOUT_DEPT_REPORT_TOOL = "scout_dept_report";

export type ScoutReportJobArgs = z.infer<typeof scoutReportQuerySchema>;

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

function stopReasonFromResult(result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const sr = (result as { stopReason?: unknown }).stopReason;
  return typeof sr === "string" ? sr : null;
}

export type StartScoutJobResult =
  | { jobId: string; status: "queued"; deduped?: false }
  | {
      jobId: string;
      status: ReportJobStatus;
      deduped: true;
      message: string;
    };

/**
 * Persist a scout_dept_report job and start it in-process (HTTP 202 pattern).
 * Firm-scoped: identical args already queued/running return that job id.
 */
export async function startScoutDeptReportJob(opts: {
  firmId: string;
  args: ScoutReportJobArgs;
  createdByUserId?: string | null;
}): Promise<StartScoutJobResult> {
  const parsed = scoutReportQuerySchema.parse(opts.args);
  const dedupeKey = scoutJobDedupeKey(opts.firmId, parsed);

  if (dedupeInFlight.has(dedupeKey)) {
    const existing = await findActiveScoutJob(opts.firmId, parsed);
    if (existing) {
      return {
        jobId: existing.id,
        status: existing.status as ReportJobStatus,
        deduped: true,
        message:
          "An identical scout_dept_report job is already queued or running for this firm.",
      };
    }
  }

  const existing = await findActiveScoutJob(opts.firmId, parsed);
  if (existing) {
    return {
      jobId: existing.id,
      status: existing.status as ReportJobStatus,
      deduped: true,
      message:
        "An identical scout_dept_report job is already queued or running for this firm.",
    };
  }

  const jobId = randomUUID();
  await db.insert(reportJobsTable).values({
    id: jobId,
    firmId: opts.firmId,
    toolName: SCOUT_DEPT_REPORT_TOOL,
    args: parsed,
    status: "queued",
    createdByUserId: opts.createdByUserId ?? null,
  });

  dedupeInFlight.add(dedupeKey);
  firmRunningSet(opts.firmId).add(jobId);

  void executeScoutJob(jobId, opts.firmId, parsed, dedupeKey);

  return { jobId, status: "queued" };
}

async function findActiveScoutJob(
  firmId: string,
  args: ScoutReportJobArgs,
): Promise<{ id: string; status: string } | null> {
  const rows = await db
    .select({
      id: reportJobsTable.id,
      status: reportJobsTable.status,
      args: reportJobsTable.args,
    })
    .from(reportJobsTable)
    .where(
      and(
        eq(reportJobsTable.firmId, firmId),
        eq(reportJobsTable.toolName, SCOUT_DEPT_REPORT_TOOL),
        inArray(reportJobsTable.status, ["queued", "running"]),
      ),
    );

  const want = scoutJobDedupeKey(firmId, args);
  for (const row of rows) {
    const rowArgs = scoutReportQuerySchema.safeParse(row.args);
    if (!rowArgs.success) continue;
    if (scoutJobDedupeKey(firmId, rowArgs.data) === want) {
      return { id: row.id, status: row.status };
    }
  }
  return null;
}

async function executeScoutJob(
  jobId: string,
  firmId: string,
  args: ScoutReportJobArgs,
  dedupeKey: string,
): Promise<void> {
  try {
    await db
      .update(reportJobsTable)
      .set({ status: "running", startedAt: new Date() })
      .where(
        and(eq(reportJobsTable.id, jobId), eq(reportJobsTable.firmId, firmId)),
      );

    const result = await firmContext.run({ firmId }, () =>
      scoutQualifiedByDepartment({
        ...args,
        wallMs: ASYNC_REPORT_WALL_MS,
      }),
    );

    await db
      .update(reportJobsTable)
      .set({
        status: "complete",
        result,
        stopReason: stopReasonFromResult(result),
        finishedAt: new Date(),
        errorSummary: null,
      })
      .where(
        and(eq(reportJobsTable.id, jobId), eq(reportJobsTable.firmId, firmId)),
      );

    logger.info(
      {
        jobId,
        firmId,
        department: args.department,
        stopReason: stopReasonFromResult(result),
      },
      "Async scout_dept_report job complete",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      { jobId, firmId, department: args.department, err },
      "Async scout_dept_report job failed",
    );
    try {
      await db
        .update(reportJobsTable)
        .set({
          status: "failed",
          errorSummary: msg.slice(0, 2000),
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(reportJobsTable.id, jobId),
            eq(reportJobsTable.firmId, firmId),
          ),
        );
    } catch (updateErr) {
      logger.error(
        { jobId, firmId, err: updateErr },
        "Failed to persist report job failure",
      );
    }
  } finally {
    dedupeInFlight.delete(dedupeKey);
    firmRunningSet(firmId).delete(jobId);
  }
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
