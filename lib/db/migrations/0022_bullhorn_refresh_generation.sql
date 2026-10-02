-- Additive Bullhorn auth safety fields. Backfills preserve existing rows by
-- defaulting to generation 0 / idle outcomes and never overwrite established
-- credentials or notice states.
ALTER TABLE "bullhorn_tokens"
  ADD COLUMN IF NOT EXISTS "refresh_generation" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "refresh_outcome" text DEFAULT 'idle' NOT NULL,
  ADD COLUMN IF NOT EXISTS "refresh_attempt_id" text,
  ADD COLUMN IF NOT EXISTS "refresh_lease_expires_at" timestamp,
  ADD COLUMN IF NOT EXISTS "refresh_uncertain_at" timestamp,
  ADD COLUMN IF NOT EXISTS "reconnect_notice_state" text DEFAULT 'idle' NOT NULL,
  ADD COLUMN IF NOT EXISTS "reconnect_notice_attempt_id" text,
  ADD COLUMN IF NOT EXISTS "reconnect_notice_claimed_at" timestamp,
  ADD COLUMN IF NOT EXISTS "reconnect_notice_completed_at" timestamp,
  ADD COLUMN IF NOT EXISTS "reconnect_notice_error" text;
--> statement-breakpoint
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "bullhorn_refresh_generation" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "bullhorn_refresh_outcome" text DEFAULT 'idle' NOT NULL,
  ADD COLUMN IF NOT EXISTS "bullhorn_refresh_attempt_id" text,
  ADD COLUMN IF NOT EXISTS "bullhorn_refresh_lease_expires_at" timestamp,
  ADD COLUMN IF NOT EXISTS "bullhorn_refresh_uncertain_at" timestamp,
  ADD COLUMN IF NOT EXISTS "bullhorn_reconnect_notice_state" text DEFAULT 'idle' NOT NULL,
  ADD COLUMN IF NOT EXISTS "bullhorn_reconnect_notice_attempt_id" text,
  ADD COLUMN IF NOT EXISTS "bullhorn_reconnect_notice_claimed_at" timestamp,
  ADD COLUMN IF NOT EXISTS "bullhorn_reconnect_notice_completed_at" timestamp,
  ADD COLUMN IF NOT EXISTS "bullhorn_reconnect_notice_error" text;
--> statement-breakpoint
ALTER TABLE "oauth_states"
  ADD COLUMN IF NOT EXISTS "expected_generation" integer,
  ADD COLUMN IF NOT EXISTS "claim_attempt_id" text,
  ADD COLUMN IF NOT EXISTS "claimed_at" timestamp;
