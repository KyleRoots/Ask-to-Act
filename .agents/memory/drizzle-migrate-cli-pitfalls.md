---
name: Drizzle migrate CLI pitfalls
description: Why drizzle-kit migrate CLI fails silently and how we replaced it with a custom programmatic migrator.
---

# Drizzle migrate CLI pitfalls

## The rule
Never use `drizzle-kit migrate` CLI in post-merge/CI scripts. Use the custom programmatic migrator at `lib/db/src/migrate.ts` via `pnpm --filter db migrate:run`.

**Why:** The `drizzle-kit migrate` CLI swallows SQL errors and exits 1 with no useful output. The `drizzle-orm` programmatic migrator runs the entire .sql file as a single query, which fails when a file contains multiple statements — even when each is individually correct.

**How to apply:** `scripts/post-merge.sh` uses `pnpm --filter db generate && pnpm --filter db migrate:run`. The custom migrator (`lib/db/src/migrate.ts`) reads the journal, checks applied migrations by `created_at` timestamp in `__drizzle_migrations`, and runs each statement-breakpoint-delimited statement individually, skipping `42P07` (relation exists) / `42710` (duplicate_object) / `42701` (duplicate_column) / `42P16` errors for idempotency.

## Regenerated-duplicate-migration trap (recurring post-merge failure)
Hand-written RAW SQL migrations (e.g. adding columns + a table) do NOT update drizzle's meta snapshot. So the very next `pnpm --filter db generate` diffs `schema.ts` against the stale snapshot and emits a fresh "catch-up" migration that RE-creates the already-existing table/columns. That migration then fails `migrate:run` on the existing DB with a duplicate-* error.
**Why this kept breaking:** the runner skipped duplicate-table/constraint but not duplicate-COLUMN (`42701`), so `ALTER TABLE … ADD COLUMN` aborted the whole post-merge run.
**How to apply:** (1) the runner must skip `42701` too (now does). (2) NEVER delete the newest generated catch-up migration to "clean up" — its `meta/<tag>_snapshot.json` is now the in-sync anchor; deleting it makes `generate` re-emit a duplicate every merge. Keep it; let it apply as a no-op. (3) Prefer letting `generate` create schema migrations so the snapshot stays in sync; reserve raw SQL only for things generate can't express, and accept the one-time catch-up migration that follows.

## Tracking table seeding
If `__drizzle_migrations` doesn't exist (fresh env or lost state), the migrator creates it and applies all journal entries. Re-seeding with SHA256/SHA1 hashes does NOT work — the table uses `(hash=tag_name, created_at=journal.when)` so use the journal `when` timestamp as the deduplication key.

## hash format
The `hash` column stores the migration tag name (e.g. `0000_neat_winter_soldier`), not a SHA1/SHA256 of the file content. The `created_at` column stores the journal entry's `when` timestamp (milliseconds since epoch). These are the lookup keys for "already applied."
