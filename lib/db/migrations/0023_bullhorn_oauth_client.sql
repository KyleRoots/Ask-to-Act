-- Per-firm Bullhorn OAuth client id and secret. Nullable so rows that
-- keep the platform env client do not need stored values. Stored values
-- are encrypted (enc:v1).
ALTER TABLE "bullhorn_tokens"
  ADD COLUMN IF NOT EXISTS "oauth_client_id" text,
  ADD COLUMN IF NOT EXISTS "oauth_client_secret" text;
--> statement-breakpoint
-- Existing rows keep using BULLHORN_CLIENT_ID / BULLHORN_CLIENT_SECRET.
-- New rows default to false and must store their own client. No firm id
-- is listed: every row present when this runs is a platform-client row.
ALTER TABLE "bullhorn_tokens"
  ADD COLUMN IF NOT EXISTS "uses_platform_client" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE "bullhorn_tokens"
SET "uses_platform_client" = true;
