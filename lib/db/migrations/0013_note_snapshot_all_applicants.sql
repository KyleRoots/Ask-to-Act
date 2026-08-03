ALTER TABLE "note_action_snapshot" ADD COLUMN IF NOT EXISTS "response_applicant" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "note_snapshot_coverage" ADD COLUMN IF NOT EXISTS "applicant_pool_synced" text DEFAULT 'responses' NOT NULL;
