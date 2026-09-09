-- Cooldown stamp for automatic Bullhorn reconnect emails (per recruiter).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "reconnect_email_sent_at" timestamp;
