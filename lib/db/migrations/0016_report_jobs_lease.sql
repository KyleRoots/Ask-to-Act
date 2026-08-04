-- Durable report job leases: workers claim queued (or stale running) rows,
-- heartbeat while executing, and reclaim after lease expiry across redeploys.
ALTER TABLE "report_jobs" ADD COLUMN IF NOT EXISTS "lease_owner" text;--> statement-breakpoint
ALTER TABLE "report_jobs" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "report_jobs" ADD COLUMN IF NOT EXISTS "heartbeat_at" timestamp;--> statement-breakpoint
ALTER TABLE "report_jobs" ADD COLUMN IF NOT EXISTS "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_jobs_claim_idx" ON "report_jobs" USING btree ("status","lease_expires_at","created_at");
