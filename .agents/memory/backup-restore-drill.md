---
name: Production DB backup restore drill
description: How to verify AskToAct Postgres backups without touching live traffic (external DB on Railway; not a Railway Postgres plugin).
---

# Backup restore drill (AskToAct production DB)

## Context
- `@workspace/api-server` on Railway has `DATABASE_URL` pointing at an **external** managed Postgres — there is **no** Railway Postgres service in the `ask-to-act` project.
- Code comments and cold-start retries assume **Neon** (`*.neon.tech`). Confirm the hostname in Railway → Variables → `DATABASE_URL` (look only at the host; do not paste the full URL into chat/logs).
- Backups are therefore owned by that provider (Neon Branch / Point-in-time restore), not by Railway.

## Goal
Prove we can restore a recent backup into a **scratch** database and read real data from it — without changing production `DATABASE_URL` or interrupting the connector.

## Neon drill (preferred if host is `*.neon.tech`)

1. Open the Neon console for the AskToAct project.
2. Confirm automated backups / history retention is enabled (Neon PITR is on by default on paid plans; free tier has limited history — note what you see).
3. Create a **branch** (or restore-to-new-branch) from a recent point in time. Name it something obvious, e.g. `restore-drill-YYYYMMDD`.
4. Copy the branch connection string (this is the scratch DB — never the production branch).
5. Locally only (do not set this on Railway production):
   ```bash
   export DATABASE_URL='<scratch branch connection string>'
   # Sanity: list a few known tables / row counts
   psql "$DATABASE_URL" -c '\dt'
   psql "$DATABASE_URL" -c 'SELECT count(*) FROM firms;'
   psql "$DATABASE_URL" -c 'SELECT count(*) FROM users;'
   ```
6. Compare counts roughly to what you expect from production (order of magnitude is enough).
7. **Delete the scratch branch** when done so it does not keep burning storage/compute.

## If the provider is not Neon
Use that provider's "restore to new instance" flow the same way: new instance → point `DATABASE_URL` locally at scratch only → `\dt` + row counts → destroy scratch.

## Pass / fail
- **Pass:** scratch restore completes; tables exist; row counts are non-zero and plausible; production Railway service stays on the original `DATABASE_URL` the whole time.
- **Fail:** restore errors, empty schema, or any step that required pointing production at the scratch URL.

## Record the result
After a successful drill, note date + provider + who ran it in this file or a short ops note. Until that happens, treat backups as unverified.

## Drill log
- **2026-07-17 — PASS (provider: Supabase, project `mtyxynfacpuwziwgdwfq` "Ask-to-Act MCP", org plan: Pro).**
  `DATABASE_URL` host is `aws-1-us-east-1.pooler.supabase.com` (Supabase pooler), NOT Neon — the Neon-first section above is kept only as generic guidance.
  Method: read-only `pg_dump -Fc` of production → `pg_restore` into a local scratch DB (`asktoact_restore_drill` on Homebrew Postgres 16) → verified all 7 app tables restored with plausible row counts (firms=2, users=13, bullhorn_tokens=2, firm_config=2, seat_activity=7, tool_usage=51) → dropped scratch DB and deleted the dump.
  Notes: 4 ignored restore errors were Supabase-internal (`supabase_vault` extension / `vault.secrets`) — irrelevant to app data. Supabase Pro also provides daily automated backups + PITR in the dashboard (Database → Backups) as the managed layer on top of this manual path.
