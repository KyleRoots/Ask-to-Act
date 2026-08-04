/**
 * In-process durable poller for report_jobs.
 * Claims queued / stale-running rows from Postgres, runs tool engines,
 * heartbeats while active. Survives api-server redeploy because the next
 * process reclaims expired leases.
 */
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";
import {
  REPORT_JOB_HEARTBEAT_MS,
  REPORT_JOB_LEASE_TTL_MS,
  REPORT_JOB_MAX_CONCURRENT,
  REPORT_JOB_POLL_MS,
  claimNextReportJob,
  runClaimedReportJob,
  setReportJobWorkerWake,
} from "./report-jobs.js";

let workerOwnerId: string | null = null;
let running = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let activeCount = 0;
const activeJobIds = new Set<string>();

function makeLeaseOwner(): string {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

async function tryFillSlots(): Promise<void> {
  if (!running || !workerOwnerId) return;

  while (activeCount < REPORT_JOB_MAX_CONCURRENT) {
    let claimed;
    try {
      claimed = await claimNextReportJob({ leaseOwner: workerOwnerId });
    } catch (err) {
      logger.error({ err }, "Report job claim failed");
      return;
    }
    if (!claimed) return;

    activeCount += 1;
    activeJobIds.add(claimed.id);
    const jobId = claimed.id;
    const leaseOwner = workerOwnerId;

    logger.info(
      {
        jobId,
        firmId: claimed.firmId,
        toolName: claimed.toolName,
        attemptCount: claimed.attemptCount,
        leaseOwner,
        activeCount,
      },
      "Report job worker claimed job",
    );

    void runClaimedReportJob({
      job: claimed,
      leaseOwner,
      leaseTtlMs: REPORT_JOB_LEASE_TTL_MS,
      heartbeatMs: REPORT_JOB_HEARTBEAT_MS,
    })
      .catch((err) => {
        logger.error({ err, jobId }, "Report job worker run threw");
      })
      .finally(() => {
        activeCount = Math.max(0, activeCount - 1);
        activeJobIds.delete(jobId);
        // Immediately try to fill the freed slot.
        void tryFillSlots();
      });
  }
}

/**
 * Start the durable report-job poller (idempotent). Call once from api-server boot.
 */
export function startReportJobWorker(opts?: {
  pollMs?: number;
}): void {
  if (running) return;
  if (process.env["REPORT_JOB_WORKER"] === "0") {
    logger.info("Report job worker disabled (REPORT_JOB_WORKER=0)");
    return;
  }

  running = true;
  workerOwnerId = makeLeaseOwner();
  const pollMs = opts?.pollMs ?? REPORT_JOB_POLL_MS;

  setReportJobWorkerWake(() => {
    void tryFillSlots();
  });

  logger.info(
    {
      leaseOwner: workerOwnerId,
      maxConcurrent: REPORT_JOB_MAX_CONCURRENT,
      pollMs,
      leaseTtlMs: REPORT_JOB_LEASE_TTL_MS,
      heartbeatMs: REPORT_JOB_HEARTBEAT_MS,
    },
    "Report job durable worker started",
  );

  // Reclaim / drain any leftover queued or stale-running jobs ASAP.
  void tryFillSlots();

  pollTimer = setInterval(() => {
    void tryFillSlots();
  }, pollMs);
  if (typeof pollTimer.unref === "function") {
    pollTimer.unref();
  }
}

/** Stop the poller (tests / graceful shutdown). In-flight jobs keep heartbeating until done. */
export function stopReportJobWorker(): void {
  running = false;
  setReportJobWorkerWake(null);
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  logger.info(
    { leaseOwner: workerOwnerId, activeCount },
    "Report job durable worker stopped",
  );
}

/** Test / ops introspection. */
export function getReportJobWorkerStats(): {
  running: boolean;
  leaseOwner: string | null;
  activeCount: number;
  activeJobIds: string[];
} {
  return {
    running,
    leaseOwner: workerOwnerId,
    activeCount,
    activeJobIds: [...activeJobIds],
  };
}
