-- Light ops-alert dedupe (fingerprint + last_sent_at cooldown). No Redis.
CREATE TABLE IF NOT EXISTS "ops_alert_state" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"severity" text NOT NULL,
	"last_sent_at" timestamp NOT NULL,
	"summary" text
);--> statement-breakpoint
ALTER TABLE "ops_alert_state" ENABLE ROW LEVEL SECURITY;
