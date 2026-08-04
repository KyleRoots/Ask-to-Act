/**
 * Light ops health evaluation for note-snapshot coverage + report_jobs.
 * Pure evaluate* helpers are unit-tested; DB gather lives in evaluateOpsHealthFromDb.
 */
import { createHash } from "node:crypto";
import { and, eq, gte, inArray, or } from "drizzle-orm";
import {
  db,
  firmsTable,
  noteSnapshotCoverageTable,
  reportJobsTable,
} from "@workspace/db";
import {
  DEFAULT_NOTE_SNAPSHOT_TTL_MS,
  noteSnapshotTtlMs,
} from "./note-snapshot-allowlist.js";
import { REPORT_JOB_MAX_ATTEMPTS } from "./report-jobs.js";
import { getReportJobWorkerStats } from "./report-job-worker.js";

export type OpsSeverity = "ok" | "warn" | "critical";

export type OpsHealthIssue = {
  code: string;
  severity: OpsSeverity;
  message: string;
  details?: Record<string, unknown>;
};

export type NoteCoverageSnapshot = {
  firmId: string;
  firmName: string | null;
  department: string;
  status: string;
  lastFullSyncAt: Date | null;
  lastAttemptAt: Date;
  errorSummary: string | null;
  applicantPoolSynced: string;
};

export type ReportJobSnapshot = {
  id: string;
  firmId: string;
  toolName: string;
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  leaseExpiresAt: Date | null;
  attemptCount: number;
  errorSummary: string | null;
};

export type OpsHealthReport = {
  status: OpsSeverity;
  checkedAt: string;
  summary: string;
  agentBrief: string;
  fingerprint: string;
  issues: OpsHealthIssue[];
  checks: {
    noteSnapshot: {
      activeFirms: number;
      coverageRows: number;
      staleOrFailed: number;
    };
    reportJobs: {
      recentFailed: number;
      staleQueued: number;
      staleRunning: number;
      poison: number;
      workerEnabled: boolean;
      workerActive: number;
    };
  };
};

export const OPS_QUEUED_WARN_MS = 10 * 60 * 1000;
export const OPS_QUEUED_CRITICAL_MS = 30 * 60 * 1000;
export const OPS_FAILED_LOOKBACK_MS = 6 * 60 * 60 * 1000;
/** Default alert cooldown (3h). Override with OPS_ALERT_COOLDOWN_MINUTES. */
export const OPS_ALERT_COOLDOWN_DEFAULT_MINUTES = 180;

const SEVERITY_RANK: Record<OpsSeverity, number> = {
  ok: 0,
  warn: 1,
  critical: 2,
};

export function maxSeverity(
  a: OpsSeverity,
  b: OpsSeverity,
): OpsSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

export function opsAlertCooldownMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env["OPS_ALERT_COOLDOWN_MINUTES"];
  if (raw === undefined || raw.trim() === "") {
    return OPS_ALERT_COOLDOWN_DEFAULT_MINUTES * 60 * 1000;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return OPS_ALERT_COOLDOWN_DEFAULT_MINUTES * 60 * 1000;
  }
  return Math.floor(n * 60 * 1000);
}

/** True when alerts are enabled (default on; set OPS_ALERTS=0 to disable). */
export function opsAlertsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env["OPS_ALERTS"];
  if (raw === undefined || raw.trim() === "") return true;
  return raw.trim() !== "0";
}

export function opsAlertFingerprint(issues: OpsHealthIssue[]): string {
  if (issues.length === 0) return "ok";
  const key = [...new Set(issues.map((i) => i.code))].sort().join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

/**
 * Deduped send gate: skip ok; send on new fingerprint; else respect cooldown.
 */
export function shouldSendOpsAlert(opts: {
  status: OpsSeverity;
  fingerprint: string;
  lastSent: { fingerprint: string; lastSentAt: Date } | null;
  cooldownMs: number;
  nowMs: number;
}): boolean {
  if (opts.status === "ok") return false;
  if (!opts.lastSent) return true;
  if (opts.lastSent.fingerprint !== opts.fingerprint) return true;
  return opts.nowMs - opts.lastSent.lastSentAt.getTime() >= opts.cooldownMs;
}

export function evaluateNoteSnapshotHealth(opts: {
  coverageRows: NoteCoverageSnapshot[];
  nowMs: number;
  ttlMs: number;
}): OpsHealthIssue[] {
  const { coverageRows, nowMs, ttlMs } = opts;
  const issues: OpsHealthIssue[] = [];

  if (coverageRows.length === 0) {
    issues.push({
      code: "note_snapshot.no_coverage",
      severity: "warn",
      message:
        "No note_snapshot_coverage rows found for active firms — cron may never have succeeded.",
    });
    return issues;
  }

  for (const row of coverageRows) {
    const label = `${row.firmName ?? row.firmId}/${row.department}`;

    if (row.status === "failed") {
      issues.push({
        code: `note_snapshot.failed:${row.firmId}:${row.department}`,
        severity: "critical",
        message: `Note snapshot sync failed for ${label}`,
        details: {
          firmId: row.firmId,
          department: row.department,
          errorSummary: row.errorSummary,
          lastAttemptAt: row.lastAttemptAt.toISOString(),
        },
      });
      continue;
    }

    if (row.status === "partial") {
      issues.push({
        code: `note_snapshot.partial:${row.firmId}:${row.department}`,
        severity: "warn",
        message: `Note snapshot coverage is partial for ${label}`,
        details: {
          firmId: row.firmId,
          department: row.department,
          lastAttemptAt: row.lastAttemptAt.toISOString(),
        },
      });
    }

    const syncAt = row.lastFullSyncAt?.getTime();
    if (row.status === "complete" && (syncAt == null || !Number.isFinite(syncAt))) {
      issues.push({
        code: `note_snapshot.missing_full_sync:${row.firmId}:${row.department}`,
        severity: "warn",
        message: `Coverage marked complete but last_full_sync_at is missing for ${label}`,
      });
      continue;
    }

    if (syncAt != null && Number.isFinite(syncAt)) {
      const age = nowMs - syncAt;
      if (age > ttlMs * 2) {
        issues.push({
          code: `note_snapshot.stale_critical:${row.firmId}:${row.department}`,
          severity: "critical",
          message: `Note snapshot for ${label} is critically stale (${Math.round(age / 60000)}m > 2× TTL)`,
          details: {
            firmId: row.firmId,
            department: row.department,
            lastFullSyncAt: new Date(syncAt).toISOString(),
            ttlMs,
          },
        });
      } else if (age > ttlMs) {
        issues.push({
          code: `note_snapshot.stale:${row.firmId}:${row.department}`,
          severity: "warn",
          message: `Note snapshot for ${label} is stale (${Math.round(age / 60000)}m > TTL)`,
          details: {
            firmId: row.firmId,
            department: row.department,
            lastFullSyncAt: new Date(syncAt).toISOString(),
            ttlMs,
          },
        });
      }
    }
  }

  return issues;
}

export function evaluateReportJobsHealth(opts: {
  jobs: ReportJobSnapshot[];
  nowMs: number;
  maxAttempts: number;
  queuedWarnMs?: number;
  queuedCriticalMs?: number;
  failedLookbackMs?: number;
}): OpsHealthIssue[] {
  const {
    jobs,
    nowMs,
    maxAttempts,
    queuedWarnMs = OPS_QUEUED_WARN_MS,
    queuedCriticalMs = OPS_QUEUED_CRITICAL_MS,
    failedLookbackMs = OPS_FAILED_LOOKBACK_MS,
  } = opts;
  const issues: OpsHealthIssue[] = [];

  const recentFailed = jobs.filter(
    (j) =>
      j.status === "failed" &&
      nowMs - j.createdAt.getTime() <= failedLookbackMs,
  );
  const poison = recentFailed.filter((j) => j.attemptCount >= maxAttempts);
  if (poison.length > 0) {
    issues.push({
      code: "report_jobs.poison",
      severity: "critical",
      message: `${poison.length} report job(s) hit max attempts (poison pill) in the last ${Math.round(failedLookbackMs / 3600000)}h`,
      details: {
        jobIds: poison.slice(0, 10).map((j) => j.id),
        maxAttempts,
      },
    });
  } else if (recentFailed.length >= 3) {
    issues.push({
      code: "report_jobs.failed_burst",
      severity: "critical",
      message: `${recentFailed.length} report jobs failed in the last ${Math.round(failedLookbackMs / 3600000)}h`,
      details: { jobIds: recentFailed.slice(0, 10).map((j) => j.id) },
    });
  } else if (recentFailed.length > 0) {
    issues.push({
      code: "report_jobs.failed_recent",
      severity: "warn",
      message: `${recentFailed.length} report job(s) failed in the last ${Math.round(failedLookbackMs / 3600000)}h`,
      details: {
        jobIds: recentFailed.slice(0, 10).map((j) => j.id),
        errors: recentFailed
          .slice(0, 5)
          .map((j) => j.errorSummary)
          .filter(Boolean),
      },
    });
  }

  for (const j of jobs.filter((x) => x.status === "queued")) {
    const age = nowMs - j.createdAt.getTime();
    if (age > queuedCriticalMs) {
      issues.push({
        code: `report_jobs.queued_critical:${j.id}`,
        severity: "critical",
        message: `Queued report job ${j.id} (${j.toolName}) is ${Math.round(age / 60000)}m old — worker may be stuck`,
        details: { jobId: j.id, firmId: j.firmId, toolName: j.toolName, ageMs: age },
      });
    } else if (age > queuedWarnMs) {
      issues.push({
        code: `report_jobs.queued_stale:${j.id}`,
        severity: "warn",
        message: `Queued report job ${j.id} (${j.toolName}) waiting ${Math.round(age / 60000)}m`,
        details: { jobId: j.id, firmId: j.firmId, toolName: j.toolName, ageMs: age },
      });
    }
  }

  for (const j of jobs.filter((x) => x.status === "running")) {
    const leaseExpired =
      j.leaseExpiresAt == null || j.leaseExpiresAt.getTime() < nowMs;
    if (j.attemptCount >= maxAttempts) {
      issues.push({
        code: `report_jobs.running_poison:${j.id}`,
        severity: "critical",
        message: `Running job ${j.id} already at max attempts (${j.attemptCount})`,
        details: { jobId: j.id, attemptCount: j.attemptCount },
      });
    } else if (leaseExpired) {
      issues.push({
        code: `report_jobs.lease_expired:${j.id}`,
        severity: "warn",
        message: `Running job ${j.id} has expired/null lease (awaiting reclaim or worker dead)`,
        details: {
          jobId: j.id,
          firmId: j.firmId,
          toolName: j.toolName,
          attemptCount: j.attemptCount,
          leaseExpiresAt: j.leaseExpiresAt?.toISOString() ?? null,
        },
      });
    } else if (j.attemptCount >= Math.max(2, maxAttempts - 1)) {
      issues.push({
        code: `report_jobs.high_attempts:${j.id}`,
        severity: "warn",
        message: `Running job ${j.id} has high attempt_count=${j.attemptCount}`,
        details: { jobId: j.id, attemptCount: j.attemptCount, maxAttempts },
      });
    }
  }

  return issues;
}

export function buildOpsHealthReport(opts: {
  issues: OpsHealthIssue[];
  nowMs: number;
  coverageRows: NoteCoverageSnapshot[];
  activeFirmCount: number;
  jobs: ReportJobSnapshot[];
  workerEnabled: boolean;
  workerActive: number;
  maxAttempts: number;
  failedLookbackMs?: number;
}): OpsHealthReport {
  const failedLookbackMs = opts.failedLookbackMs ?? OPS_FAILED_LOOKBACK_MS;
  let status: OpsSeverity = "ok";
  for (const issue of opts.issues) {
    status = maxSeverity(status, issue.severity);
  }

  const recentFailed = opts.jobs.filter(
    (j) =>
      j.status === "failed" &&
      opts.nowMs - j.createdAt.getTime() <= failedLookbackMs,
  );
  const staleQueued = opts.jobs.filter(
    (j) =>
      j.status === "queued" &&
      opts.nowMs - j.createdAt.getTime() > OPS_QUEUED_WARN_MS,
  );
  const staleRunning = opts.jobs.filter(
    (j) =>
      j.status === "running" &&
      (j.leaseExpiresAt == null || j.leaseExpiresAt.getTime() < opts.nowMs),
  );
  const poison = recentFailed.filter(
    (j) => j.attemptCount >= opts.maxAttempts,
  );
  const staleOrFailed = opts.issues.filter((i) =>
    i.code.startsWith("note_snapshot."),
  ).length;

  const fingerprint = opsAlertFingerprint(opts.issues);
  const summary =
    status === "ok"
      ? "All ops checks passed (note-snapshot coverage + report_jobs)."
      : opts.issues.map((i) => `[${i.severity}] ${i.message}`).join(" · ");

  const agentBrief = [
    "AskToAct ops alert — investigate and fix if clear.",
    `severity: ${status}`,
    `checkedAt: ${new Date(opts.nowMs).toISOString()}`,
    `fingerprint: ${fingerprint}`,
    `summary: ${summary}`,
    "",
    "Issues:",
    ...(opts.issues.length === 0
      ? ["  (none)"]
      : opts.issues.map(
          (i) =>
            `  - [${i.severity}] ${i.code}: ${i.message}` +
            (i.details ? ` | ${JSON.stringify(i.details)}` : ""),
        )),
    "",
    "Checks:",
    `  noteSnapshot: activeFirms=${opts.activeFirmCount} coverageRows=${opts.coverageRows.length} staleOrFailed=${staleOrFailed}`,
    `  reportJobs: recentFailed=${recentFailed.length} staleQueued=${staleQueued.length} staleRunning=${staleRunning.length} poison=${poison.length} workerEnabled=${opts.workerEnabled} workerActive=${opts.workerActive}`,
    "",
    "Hints: GET /api/internal/ops-health (service bearer); note-snapshot cron POST /api/firms/:id/note-snapshot/sync; report_jobs lease worker in api-server.",
  ].join("\n");

  return {
    status,
    checkedAt: new Date(opts.nowMs).toISOString(),
    summary,
    agentBrief,
    fingerprint,
    issues: opts.issues,
    checks: {
      noteSnapshot: {
        activeFirms: opts.activeFirmCount,
        coverageRows: opts.coverageRows.length,
        staleOrFailed,
      },
      reportJobs: {
        recentFailed: recentFailed.length,
        staleQueued: staleQueued.length,
        staleRunning: staleRunning.length,
        poison: poison.length,
        workerEnabled: opts.workerEnabled,
        workerActive: opts.workerActive,
      },
    },
  };
}

/** Gather DB state and produce a full ops health report. */
export async function evaluateOpsHealthFromDb(
  nowMs: number = Date.now(),
): Promise<OpsHealthReport> {
  const ttlMs = noteSnapshotTtlMs();
  const maxAttempts = REPORT_JOB_MAX_ATTEMPTS;
  const failedSince = new Date(nowMs - OPS_FAILED_LOOKBACK_MS);

  const activeFirms = await db
    .select({ id: firmsTable.id, name: firmsTable.name })
    .from(firmsTable)
    .where(eq(firmsTable.status, "active"));

  const activeIds = activeFirms.map((f) => f.id);
  const firmNameById = new Map(activeFirms.map((f) => [f.id, f.name]));

  let coverageRows: NoteCoverageSnapshot[] = [];
  if (activeIds.length > 0) {
    const rows = await db
      .select()
      .from(noteSnapshotCoverageTable)
      .where(inArray(noteSnapshotCoverageTable.firmId, activeIds));
    coverageRows = rows.map((r) => ({
      firmId: r.firmId,
      firmName: firmNameById.get(r.firmId) ?? null,
      department: r.department,
      status: r.status,
      lastFullSyncAt: r.lastFullSyncAt,
      lastAttemptAt: r.lastAttemptAt,
      errorSummary: r.errorSummary,
      applicantPoolSynced: r.applicantPoolSynced,
    }));
  }

  const jobRows = await db
    .select()
    .from(reportJobsTable)
    .where(
      or(
        inArray(reportJobsTable.status, ["queued", "running"]),
        and(
          eq(reportJobsTable.status, "failed"),
          gte(reportJobsTable.createdAt, failedSince),
        ),
      ),
    )
    .limit(200);

  const jobs: ReportJobSnapshot[] = jobRows.map((j) => ({
    id: j.id,
    firmId: j.firmId,
    toolName: j.toolName,
    status: j.status,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    leaseExpiresAt: j.leaseExpiresAt,
    attemptCount: j.attemptCount ?? 0,
    errorSummary: j.errorSummary,
  }));

  const issues = [
    ...evaluateNoteSnapshotHealth({ coverageRows, nowMs, ttlMs }),
    ...evaluateReportJobsHealth({ jobs, nowMs, maxAttempts }),
  ];

  const workerStats = getReportJobWorkerStats();
  // Worker disabled via env is an ops concern when jobs are queued.
  const workerEnabled = process.env["REPORT_JOB_WORKER"] !== "0";
  if (!workerEnabled && jobs.some((j) => j.status === "queued" || j.status === "running")) {
    issues.push({
      code: "report_jobs.worker_disabled",
      severity: "critical",
      message: "REPORT_JOB_WORKER=0 but queued/running jobs exist",
    });
  }

  return buildOpsHealthReport({
    issues,
    nowMs,
    coverageRows,
    activeFirmCount: activeIds.length,
    jobs,
    workerEnabled,
    workerActive: workerStats.activeCount,
    maxAttempts,
  });
}

/** Re-export TTL default for docs/tests. */
export { DEFAULT_NOTE_SNAPSHOT_TTL_MS };
