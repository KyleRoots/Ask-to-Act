-- Multi-file staged uploads: shared batch id for one browser drop page.
ALTER TABLE "staged_file_uploads" ADD COLUMN IF NOT EXISTS "batch_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staged_file_uploads_batch_id_idx" ON "staged_file_uploads" USING btree ("batch_id");
