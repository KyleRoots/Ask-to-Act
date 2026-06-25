ALTER TABLE "bullhorn_tokens" ADD COLUMN IF NOT EXISTS "oauth_url" text;--> statement-breakpoint
ALTER TABLE "bullhorn_tokens" ADD COLUMN IF NOT EXISTS "rest_url" text;--> statement-breakpoint
ALTER TABLE "bullhorn_tokens" ADD COLUMN IF NOT EXISTS "login_url" text;--> statement-breakpoint
ALTER TABLE "bullhorn_tokens" ADD COLUMN IF NOT EXISTS "auth_mode" text DEFAULT 'oauth' NOT NULL;--> statement-breakpoint
ALTER TABLE "bullhorn_tokens" ADD COLUMN IF NOT EXISTS "connected_at" timestamp;--> statement-breakpoint
UPDATE "bullhorn_tokens" SET "firm_id" = 'firm_myticas_28404', "auth_mode" = 'service' WHERE "id" = 'default' AND "firm_id" IS NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bullhorn_tokens" ADD CONSTRAINT "bullhorn_tokens_firm_id_unique" UNIQUE ("firm_id");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
