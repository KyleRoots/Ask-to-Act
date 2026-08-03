import { logger } from "./logger.js";
import { isSnapshotIndexedAction } from "./note-snapshot-allowlist.js";
import {
  upsertSnapshotNotes,
  writeCoverage,
  type CoverageStatus,
} from "./note-snapshot-store.js";
import {
  harvestDepartmentSnapshotNotes,
  listInternalDepartments,
  resolveDepartmentLabel,
} from "./scout-screen.js";

export type NoteSnapshotSyncResult = {
  firmId: string;
  elapsedMs: number;
  departmentsRequested: string[];
  departments: Array<{
    department: string;
    status: CoverageStatus;
    notesUpserted: number;
    jobsLoaded: number;
    jobsTotal: number;
    applicantsUnique: number;
    submissionRowsSeen: number;
    errorSummary?: string;
  }>;
  notesUpsertedTotal: number;
};

/**
 * Background sync: walk open jobs → all applicants → allowlisted notes,
 * upsert into note_action_snapshot (with response_applicant tags), write
 * per-department coverage with applicant_pool_synced=all.
 * Must run inside firmContext.run({ firmId }).
 */
export async function syncNoteSnapshotForFirm(args: {
  firmId: string;
  /** Optional single department or nickname; default = all discovered depts. */
  department?: string;
}): Promise<NoteSnapshotSyncResult> {
  const startedAt = Date.now();
  let departments: string[];
  if (args.department?.trim()) {
    const resolved = await resolveDepartmentLabel(args.department.trim());
    departments = [resolved.department];
  } else {
    departments = await listInternalDepartments();
  }

  const summaries: NoteSnapshotSyncResult["departments"] = [];
  let notesUpsertedTotal = 0;

  for (const department of departments) {
    logger.info(
      { firmId: args.firmId, department },
      "note-snapshot sync: starting department",
    );
    const harvested = await harvestDepartmentSnapshotNotes({
      department,
      isAllowlisted: isSnapshotIndexedAction,
    });

    let status: CoverageStatus;
    if (harvested.errorSummary && harvested.rows.length === 0 && !harvested.complete) {
      status = harvested.errorSummary.includes("truncated")
        ? "partial"
        : "failed";
    } else if (harvested.complete) {
      status = "complete";
    } else {
      status = "partial";
    }

    let notesUpserted = 0;
    try {
      notesUpserted = await upsertSnapshotNotes(args.firmId, harvested.rows);
      notesUpsertedTotal += notesUpserted;
      await writeCoverage({
        firmId: args.firmId,
        department,
        status,
        notesUpserted,
        applicantPoolSynced: harvested.applicantPool,
        errorSummary: harvested.errorSummary,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      status = "failed";
      await writeCoverage({
        firmId: args.firmId,
        department,
        status: "failed",
        notesUpserted,
        applicantPoolSynced: harvested.applicantPool,
        errorSummary: msg.slice(0, 500),
      });
      summaries.push({
        department,
        status,
        notesUpserted,
        jobsLoaded: harvested.jobsLoaded,
        jobsTotal: harvested.jobsTotal,
        applicantsUnique: harvested.applicantsUnique,
        submissionRowsSeen: harvested.submissionRowsSeen,
        errorSummary: msg.slice(0, 500),
      });
      logger.error(
        { firmId: args.firmId, department, err },
        "note-snapshot sync: department failed",
      );
      continue;
    }

    summaries.push({
      department,
      status,
      notesUpserted,
      jobsLoaded: harvested.jobsLoaded,
      jobsTotal: harvested.jobsTotal,
      applicantsUnique: harvested.applicantsUnique,
      submissionRowsSeen: harvested.submissionRowsSeen,
      ...(harvested.errorSummary
        ? { errorSummary: harvested.errorSummary }
        : {}),
    });
    logger.info(
      {
        firmId: args.firmId,
        department,
        status,
        notesUpserted,
        jobsLoaded: harvested.jobsLoaded,
        applicantPoolSynced: harvested.applicantPool,
      },
      "note-snapshot sync: department done",
    );
  }

  return {
    firmId: args.firmId,
    elapsedMs: Date.now() - startedAt,
    departmentsRequested: departments,
    departments: summaries,
    notesUpsertedTotal,
  };
}
