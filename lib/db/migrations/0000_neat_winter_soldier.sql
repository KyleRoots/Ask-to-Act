CREATE TABLE IF NOT EXISTS "bullhorn_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"refresh_token" text NOT NULL,
	"firm_id" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "firms" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"subscription_status" text,
	"seat_limit" integer,
	"logo_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"api_key" text NOT NULL,
	"firm_id" text,
	"role" text DEFAULT 'recruiter' NOT NULL,
	"refresh_token" text,
	"bh_rest_token" text,
	"rest_url" text,
	"token_expires_at" bigint,
	"session_expires_at" bigint,
	"invited_at" timestamp,
	"enroll_token" text,
	"enroll_token_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seat_activity" (
	"user_id" text NOT NULL,
	"firm_id" text NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	"first_call_at" timestamp DEFAULT now() NOT NULL,
	"last_call_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "seat_activity_user_id_year_month_pk" PRIMARY KEY("user_id","year","month")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tool_usage" (
	"user_id" text NOT NULL,
	"firm_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"first_call_at" timestamp DEFAULT now() NOT NULL,
	"last_call_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tool_usage_user_id_tool_name_year_month_pk" PRIMARY KEY("user_id","tool_name","year","month")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "seat_activity" ADD CONSTRAINT "seat_activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "seat_activity" ADD CONSTRAINT "seat_activity_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tool_usage" ADD CONSTRAINT "tool_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tool_usage" ADD CONSTRAINT "tool_usage_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE ("email");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_api_key_unique" UNIQUE ("api_key");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_enroll_token_unique" UNIQUE ("enroll_token");
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
