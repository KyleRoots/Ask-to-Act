CREATE TABLE "firm_config" (
	"firm_id" text PRIMARY KEY NOT NULL,
	"field_map" jsonb NOT NULL,
	"discovered_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bullhorn_tokens" ADD COLUMN "oauth_url" text;--> statement-breakpoint
ALTER TABLE "bullhorn_tokens" ADD COLUMN "rest_url" text;--> statement-breakpoint
ALTER TABLE "bullhorn_tokens" ADD COLUMN "login_url" text;--> statement-breakpoint
ALTER TABLE "bullhorn_tokens" ADD COLUMN "auth_mode" text DEFAULT 'oauth' NOT NULL;--> statement-breakpoint
ALTER TABLE "bullhorn_tokens" ADD COLUMN "connected_at" timestamp;--> statement-breakpoint
ALTER TABLE "bullhorn_tokens" ADD CONSTRAINT "bullhorn_tokens_firm_id_unique" UNIQUE("firm_id");