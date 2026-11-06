-- Per-firm Bullhorn OAuth client id and secret. Nullable so rows that
-- keep the platform env client do not need stored values. Stored values
-- are encrypted (enc:v1).
ALTER TABLE "bullhorn_tokens"
  ADD COLUMN IF NOT EXISTS "oauth_client_id" text,
  ADD COLUMN IF NOT EXISTS "oauth_client_secret" text;
--> statement-breakpoint
-- Rows with no stored client keep using BULLHORN_CLIENT_ID /
-- BULLHORN_CLIENT_SECRET. A row that already has a client stays false.
-- No firm id is listed.
ALTER TABLE "bullhorn_tokens"
  ADD COLUMN IF NOT EXISTS "uses_platform_client" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE "bullhorn_tokens"
SET "uses_platform_client" = true
WHERE "oauth_client_id" IS NULL
  AND "oauth_client_secret" IS NULL;
