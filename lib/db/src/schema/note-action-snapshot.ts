import {
  pgTable,
  text,
  bigint,
  integer,
  timestamp,
  boolean,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { firmsTable } from "./firms";

/**
 * Firm-scoped index of Bullhorn notes by action (Scout Screen family first).
 * Backfills the empty `/search/Note` Lucene gap so department reports can rank
 * without walking every applicant inside a ChatGPT turn.
 *
 * PK is (firm_id, note_id) — note ids are not unique across Bullhorn swimlanes.
 */
export const noteActionSnapshotTable = pgTable(
  "note_action_snapshot",
  {
    firmId: text("firm_id")
      .notNull()
      .references(() => firmsTable.id, { onDelete: "cascade" }),
    noteId: bigint("note_id", { mode: "number" }).notNull(),
    action: text("action").notNull(),
    candidateId: integer("candidate_id").notNull(),
    jobId: integer("job_id"),
    department: text("department"),
    noteDateAdded: bigint("note_date_added", { mode: "number" }).notNull(),
    candidateFirst: text("candidate_first"),
    candidateLast: text("candidate_last"),
    /** True when the candidate had a Response-bucket JobSubmission on a scanned open job. */
    responseApplicant: boolean("response_applicant").notNull().default(false),
    syncedAt: timestamp("synced_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.firmId, table.noteId] }),
    index("note_action_snapshot_dept_action_date_idx").on(
      table.firmId,
      table.department,
      table.action,
      table.noteDateAdded,
    ),
    index("note_action_snapshot_synced_idx").on(table.firmId, table.syncedAt),
  ],
);

export type NoteActionSnapshot = typeof noteActionSnapshotTable.$inferSelect;

/**
 * Per-department sync coverage for note_action_snapshot.
 * Reports treat the snapshot as authoritative only when status=complete and
 * last_full_sync_at is within the configured TTL.
 */
export const noteSnapshotCoverageTable = pgTable(
  "note_snapshot_coverage",
  {
    firmId: text("firm_id")
      .notNull()
      .references(() => firmsTable.id, { onDelete: "cascade" }),
    department: text("department").notNull(),
    status: text("status").notNull(), // complete | partial | failed
    lastFullSyncAt: timestamp("last_full_sync_at"),
    lastAttemptAt: timestamp("last_attempt_at").notNull().defaultNow(),
    notesUpserted: integer("notes_upserted").notNull().default(0),
    errorSummary: text("error_summary"),
    /**
     * Which applicant pool the last successful sync walked.
     * `all` = every JobSubmission on open jobs (response_applicant tagged).
     * `responses` = Response bucket only (legacy / incomplete for pool=all reads).
     */
    applicantPoolSynced: text("applicant_pool_synced")
      .notNull()
      .default("responses"),
  },
  (table) => [
    primaryKey({ columns: [table.firmId, table.department] }),
  ],
);

export type NoteSnapshotCoverage = typeof noteSnapshotCoverageTable.$inferSelect;
