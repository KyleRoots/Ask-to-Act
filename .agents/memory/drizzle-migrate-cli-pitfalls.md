---
name: Drizzle migrate CLI pitfalls
description: Why drizzle-kit migrate CLI fails silently and how we replaced it with a custom programmatic migrator.
---

# Drizzle migrate CLI pitfalls

## The rule
Never use `drizzle-kit migrate` CLI in post-merge/CI scripts. Use the custom programmatic migrator at `lib/db/src/migrate.ts` via `pnpm --filter db migrate:run`.

**Why:** The `drizzle-kit migrate` CLI swallows SQL errors and exits 1 with no useful output. The `drizzle-orm` programmatic migrator runs the entire .sql file as a single query, which fails when a file contains multiple statements — even when each is individually correct.

**How to apply:** `scripts/post-merge.sh` uses `pnpm --filter db generate && pnpm --filter db migrate:run`. The custom migrator (`lib/db/src/migrate.ts`) reads the journal, checks applied migrations by `created_at` timestamp in `__drizzle_migrations`, and runs each statement-breakpoint-delimited statement individually, skipping `42P07`/`42710`/`42P16` errors for idempotency.

## Tracking table seeding
If `__drizzle_migrations` doesn't exist (fresh env or lost state), the migrator creates it and applies all journal entries. Re-seeding with SHA256/SHA1 hashes does NOT work — the table uses `(hash=tag_name, created_at=journal.when)` so use the journal `when` timestamp as the deduplication key.

## hash format
The `hash` column stores the migration tag name (e.g. `0000_neat_winter_soldier`), not a SHA1/SHA256 of the file content. The `created_at` column stores the journal entry's `when` timestamp (milliseconds since epoch). These are the lookup keys for "already applied."
