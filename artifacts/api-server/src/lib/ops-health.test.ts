import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  firmsTable: {},
  noteSnapshotCoverageTable: {},
  reportJobsTable: {},
  opsAlertStateTable: {},
}));

vi.mock("./report-job-worker.js", () => ({
  getReportJobWorkerStats: () => ({
    running: false,
    leaseOwner: null,
    activeCount: 0,
    activeJobIds: [],
  }),
}));

vi.mock("./logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  buildOpsHealthReport,
  evaluateNoteSnapshotHealth,
  evaluateReportJobsHealth,
  maxSeverity,
  opsAlertCooldownMs,
  opsAlertFingerprint,
  opsAlertsEnabled,
  shouldSendOpsAlert,
  OPS_QUEUED_WARN_MS,
  OPS_QUEUED_CRITICAL_MS,
  type NoteCoverageSnapshot,
  type ReportJobSnapshot,
} from "./ops-health.js";

const now = Date.parse("2026-08-04T20:00:00.000Z");
const ttlMs = 2 * 60 * 60 * 1000;

function coverage(
  partial: Partial<NoteCoverageSnapshot> &
    Pick<NoteCoverageSnapshot, "firmId" | "department" | "status">,
): NoteCoverageSnapshot {
  return {
    firmName: "Acme",
    lastFullSyncAt: new Date(now - 30 * 60 * 1000),
    lastAttemptAt: new Date(now - 30 * 60 * 1000),
    errorSummary: null,
    applicantPoolSynced: "all",
    ...partial,
  };
}

function job(
  partial: Partial<ReportJobSnapshot> &
    Pick<ReportJobSnapshot, "id" | "status">,
): ReportJobSnapshot {
  return {
    firmId: "firm-a",
    toolName: "scout_dept_report",
    createdAt: new Date(now - 60_000),
    startedAt: null,
    leaseExpiresAt: null,
    attemptCount: 0,
    errorSummary: null,
    ...partial,
  };
}

describe("ops health severity helpers", () => {
  it("ranks severities", () => {
    expect(maxSeverity("ok", "warn")).toBe("warn");
    expect(maxSeverity("warn", "critical")).toBe("critical");
    expect(maxSeverity("ok", "ok")).toBe("ok");
  });

  it("reads OPS_ALERTS and cooldown env", () => {
    expect(opsAlertsEnabled({})).toBe(true);
    expect(opsAlertsEnabled({ OPS_ALERTS: "0" })).toBe(false);
    expect(opsAlertsEnabled({ OPS_ALERTS: "1" })).toBe(true);
    expect(opsAlertCooldownMs({})).toBe(180 * 60 * 1000);
    expect(opsAlertCooldownMs({ OPS_ALERT_COOLDOWN_MINUTES: "60" })).toBe(
      60 * 60 * 1000,
    );
  });
});

describe("evaluateNoteSnapshotHealth", () => {
  it("warns when no coverage rows exist", () => {
    const issues = evaluateNoteSnapshotHealth({
      coverageRows: [],
      nowMs: now,
      ttlMs,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("note_snapshot.no_coverage");
    expect(issues[0]!.severity).toBe("warn");
  });

  it("marks failed sync critical and stale sync warn/critical by TTL", () => {
    const failed = evaluateNoteSnapshotHealth({
      coverageRows: [
        coverage({
          firmId: "f1",
          department: "Eng",
          status: "failed",
          errorSummary: "boom",
        }),
      ],
      nowMs: now,
      ttlMs,
    });
    expect(failed[0]!.severity).toBe("critical");
    expect(failed[0]!.code).toContain("note_snapshot.failed");

    const stale = evaluateNoteSnapshotHealth({
      coverageRows: [
        coverage({
          firmId: "f1",
          department: "Eng",
          status: "complete",
          lastFullSyncAt: new Date(now - ttlMs - 60_000),
        }),
      ],
      nowMs: now,
      ttlMs,
    });
    expect(stale[0]!.severity).toBe("warn");

    const veryStale = evaluateNoteSnapshotHealth({
      coverageRows: [
        coverage({
          firmId: "f1",
          department: "Eng",
          status: "complete",
          lastFullSyncAt: new Date(now - ttlMs * 2 - 60_000),
        }),
      ],
      nowMs: now,
      ttlMs,
    });
    expect(veryStale[0]!.severity).toBe("critical");
  });

  it("returns no issues for fresh complete coverage", () => {
    const issues = evaluateNoteSnapshotHealth({
      coverageRows: [
        coverage({
          firmId: "f1",
          department: "Eng",
          status: "complete",
          lastFullSyncAt: new Date(now - 10 * 60 * 1000),
        }),
      ],
      nowMs: now,
      ttlMs,
    });
    expect(issues).toEqual([]);
  });
});

describe("evaluateReportJobsHealth", () => {
  it("flags recent failures, poison pills, and stale queued/running", () => {
    const failed = evaluateReportJobsHealth({
      jobs: [
        job({
          id: "j1",
          status: "failed",
          attemptCount: 1,
          errorSummary: "x",
        }),
      ],
      nowMs: now,
      maxAttempts: 5,
    });
    expect(failed.some((i) => i.code === "report_jobs.failed_recent")).toBe(
      true,
    );

    // Aged terminal failures outside the 2h lookback must not keep alerting.
    const aged = evaluateReportJobsHealth({
      jobs: [
        job({
          id: "j-aged",
          status: "failed",
          attemptCount: 1,
          createdAt: new Date(now - 3 * 60 * 60 * 1000),
        }),
      ],
      nowMs: now,
      maxAttempts: 5,
    });
    expect(aged.some((i) => i.code.startsWith("report_jobs.failed"))).toBe(
      false,
    );

    const poison = evaluateReportJobsHealth({
      jobs: [
        job({
          id: "j2",
          status: "failed",
          attemptCount: 5,
        }),
      ],
      nowMs: now,
      maxAttempts: 5,
    });
    expect(poison.some((i) => i.code === "report_jobs.poison")).toBe(true);

    const queued = evaluateReportJobsHealth({
      jobs: [
        job({
          id: "j3",
          status: "queued",
          createdAt: new Date(now - OPS_QUEUED_WARN_MS - 1000),
        }),
        job({
          id: "j4",
          status: "queued",
          createdAt: new Date(now - OPS_QUEUED_CRITICAL_MS - 1000),
        }),
      ],
      nowMs: now,
      maxAttempts: 5,
    });
    expect(queued.some((i) => i.severity === "warn")).toBe(true);
    expect(queued.some((i) => i.severity === "critical")).toBe(true);

    const lease = evaluateReportJobsHealth({
      jobs: [
        job({
          id: "j5",
          status: "running",
          leaseExpiresAt: new Date(now - 1000),
          attemptCount: 1,
        }),
      ],
      nowMs: now,
      maxAttempts: 5,
    });
    expect(lease.some((i) => i.code.startsWith("report_jobs.lease_expired"))).toBe(
      true,
    );
  });
});

describe("shouldSendOpsAlert dedupe", () => {
  it("skips ok, sends first alert, respects cooldown, resets on new fingerprint", () => {
    expect(
      shouldSendOpsAlert({
        status: "ok",
        fingerprint: "abc",
        lastSent: null,
        cooldownMs: 3600_000,
        nowMs: now,
      }),
    ).toBe(false);

    expect(
      shouldSendOpsAlert({
        status: "warn",
        fingerprint: "abc",
        lastSent: null,
        cooldownMs: 3600_000,
        nowMs: now,
      }),
    ).toBe(true);

    expect(
      shouldSendOpsAlert({
        status: "warn",
        fingerprint: "abc",
        lastSent: { fingerprint: "abc", lastSentAt: new Date(now - 60_000) },
        cooldownMs: 3600_000,
        nowMs: now,
      }),
    ).toBe(false);

    expect(
      shouldSendOpsAlert({
        status: "warn",
        fingerprint: "abc",
        lastSent: {
          fingerprint: "abc",
          lastSentAt: new Date(now - 3600_000 - 1),
        },
        cooldownMs: 3600_000,
        nowMs: now,
      }),
    ).toBe(true);

    expect(
      shouldSendOpsAlert({
        status: "critical",
        fingerprint: "newfp",
        lastSent: { fingerprint: "abc", lastSentAt: new Date(now) },
        cooldownMs: 3600_000,
        nowMs: now,
      }),
    ).toBe(true);
  });

  it("builds stable fingerprints and agent brief", () => {
    const issues = evaluateNoteSnapshotHealth({
      coverageRows: [],
      nowMs: now,
      ttlMs,
    });
    const fp1 = opsAlertFingerprint(issues);
    const fp2 = opsAlertFingerprint([...issues].reverse());
    expect(fp1).toBe(fp2);
    expect(fp1).not.toBe("ok");

    const report = buildOpsHealthReport({
      issues,
      nowMs: now,
      coverageRows: [],
      activeFirmCount: 1,
      jobs: [],
      workerEnabled: true,
      workerActive: 0,
      maxAttempts: 5,
    });
    expect(report.status).toBe("warn");
    expect(report.agentBrief).toMatch(/AskToAct ops alert/);
    expect(report.agentBrief).toMatch(/note_snapshot.no_coverage/);
    expect(report.fingerprint).toBe(fp1);
  });
});
