ALTER TABLE "bullhorn_tokens" ADD COLUMN "auth_healthy" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bullhorn_tokens" ADD COLUMN "last_auth_error_at" timestamp;--> statement-breakpoint
ALTER TABLE "bullhorn_tokens" ADD COLUMN "last_auth_error" text;
