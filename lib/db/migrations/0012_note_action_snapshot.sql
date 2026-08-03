CREATE TABLE IF NOT EXISTS "note_action_snapshot" (
	"firm_id" text NOT NULL,
	"note_id" bigint NOT NULL,
	"action" text NOT NULL,
	"candidate_id" integer NOT NULL,
	"job_id" integer,
	"department" text,
	"note_date_added" bigint NOT NULL,
	"candidate_first" text,
	"candidate_last" text,
	"synced_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "note_action_snapshot_firm_id_note_id_pk" PRIMARY KEY("firm_id","note_id")
);--> statement-breakpoint
ALTER TABLE "note_action_snapshot" ADD CONSTRAINT "note_action_snapshot_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "note_action_snapshot_dept_action_date_idx" ON "note_action_snapshot" USING btree ("firm_id","department","action","note_date_added");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "note_action_snapshot_synced_idx" ON "note_action_snapshot" USING btree ("firm_id","synced_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "note_snapshot_coverage" (
	"firm_id" text NOT NULL,
	"department" text NOT NULL,
	"status" text NOT NULL,
	"last_full_sync_at" timestamp,
	"last_attempt_at" timestamp DEFAULT now() NOT NULL,
	"notes_upserted" integer DEFAULT 0 NOT NULL,
	"error_summary" text,
	CONSTRAINT "note_snapshot_coverage_firm_id_department_pk" PRIMARY KEY("firm_id","department")
);--> statement-breakpoint
ALTER TABLE "note_snapshot_coverage" ADD CONSTRAINT "note_snapshot_coverage_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
