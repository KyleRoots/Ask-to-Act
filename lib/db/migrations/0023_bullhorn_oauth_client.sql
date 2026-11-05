-- Per-firm Bullhorn OAuth client id and secret. Nullable so the service firm
-- keeps using BULLHORN_CLIENT_ID / BULLHORN_CLIENT_SECRET from the environment.
-- Values are stored encrypted (enc:v1). Existing rows are unchanged.
ALTER TABLE "bullhorn_tokens"
  ADD COLUMN IF NOT EXISTS "oauth_client_id" text,
  ADD COLUMN IF NOT EXISTS "oauth_client_secret" text;
