CREATE TABLE IF NOT EXISTS "report_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"firm_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"args" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"error_summary" text,
	"stop_reason" text,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp
);--> statement-breakpoint
ALTER TABLE "report_jobs" ADD CONSTRAINT "report_jobs_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_jobs" ADD CONSTRAINT "report_jobs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_jobs_firm_status_created_idx" ON "report_jobs" USING btree ("firm_id","status","created_at");
