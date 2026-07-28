CREATE TABLE "user_mailboxes" (
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"mailbox_email" text,
	"refresh_token" text,
	"access_token" text,
	"token_expires_at" bigint,
	"scope" text,
	"connect_token" text,
	"connect_token_expires_at" timestamp,
	"connected_at" timestamp,
	"revoked_at" timestamp,
	"last_error" text,
	"last_error_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_mailboxes_user_id_provider_pk" PRIMARY KEY("user_id","provider"),
	CONSTRAINT "user_mailboxes_connect_token_unique" UNIQUE("connect_token")
);--> statement-breakpoint
CREATE TABLE "email_send_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"firm_id" text NOT NULL,
	"provider" text NOT NULL,
	"entity_type" text NOT NULL,
	"record_id" integer NOT NULL,
	"job_order_id" integer,
	"recipient_email" text NOT NULL,
	"subject" text NOT NULL,
	"body_preview" text,
	"body_hash" text,
	"status" text NOT NULL,
	"provider_message_id" text,
	"internet_message_id" text,
	"bullhorn_note_id" integer,
	"error_category" text,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"send_attempted_at" timestamp,
	"sent_at" timestamp,
	"bullhorn_logged_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "user_mailboxes" ADD CONSTRAINT "user_mailboxes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_send_logs" ADD CONSTRAINT "email_send_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_send_logs" ADD CONSTRAINT "email_send_logs_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_mailboxes_provider_idx" ON "user_mailboxes" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "user_mailboxes_connect_token_idx" ON "user_mailboxes" USING btree ("connect_token");--> statement-breakpoint
CREATE INDEX "email_send_logs_user_id_idx" ON "email_send_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "email_send_logs_firm_id_idx" ON "email_send_logs" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "email_send_logs_entity_idx" ON "email_send_logs" USING btree ("entity_type","record_id");--> statement-breakpoint
CREATE INDEX "email_send_logs_status_idx" ON "email_send_logs" USING btree ("status");
