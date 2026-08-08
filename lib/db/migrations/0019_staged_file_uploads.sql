-- Short-lived staged file bytes for MCP fileRef uploads (ChatGPT/Cursor hosts
-- that cannot reliably inject chat-attachment base64 into tool calls).
CREATE TABLE IF NOT EXISTS "staged_file_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"firm_id" text NOT NULL,
	"user_id" text NOT NULL,
	"upload_token" text NOT NULL,
	"file_name" text,
	"content_type" text,
	"content" bytea,
	"size_bytes" integer,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "staged_file_uploads_upload_token_unique" UNIQUE("upload_token")
);--> statement-breakpoint
ALTER TABLE "staged_file_uploads" ADD CONSTRAINT "staged_file_uploads_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staged_file_uploads" ADD CONSTRAINT "staged_file_uploads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staged_file_uploads_firm_user_idx" ON "staged_file_uploads" USING btree ("firm_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staged_file_uploads_expires_at_idx" ON "staged_file_uploads" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "staged_file_uploads" ENABLE ROW LEVEL SECURITY;
