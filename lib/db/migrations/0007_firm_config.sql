CREATE TABLE IF NOT EXISTS "firm_config" (
	"firm_id" text PRIMARY KEY NOT NULL,
	"field_map" jsonb NOT NULL,
	"discovered_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
