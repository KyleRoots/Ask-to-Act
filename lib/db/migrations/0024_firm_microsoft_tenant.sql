-- Nullable per-firm Microsoft 365 tenant. No firm is backfilled: a null
-- value keeps authorize, token exchange, and refresh on M365_TENANT_ID.
ALTER TABLE "firms"
  ADD COLUMN IF NOT EXISTS "microsoft_tenant_id" text;
