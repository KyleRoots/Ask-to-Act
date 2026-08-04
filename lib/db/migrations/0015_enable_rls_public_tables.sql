-- Server-only app (Railway api-server via DATABASE_URL). Enable RLS with no
-- policies so Supabase PostgREST anon/authenticated cannot read/write these
-- tables. Matches older public tables (users, firms, bullhorn_tokens, …).
ALTER TABLE "user_mailboxes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_send_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "note_action_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "note_snapshot_coverage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "report_jobs" ENABLE ROW LEVEL SECURITY;
