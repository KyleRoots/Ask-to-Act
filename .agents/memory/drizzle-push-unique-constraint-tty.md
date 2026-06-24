---
name: drizzle-kit push hangs on unique-constraint prompt
description: Why `pnpm --filter db push` fails in CI/post-merge and how to add a unique constraint to a populated table
---

# drizzle-kit push + unique constraint on a populated table

When `drizzle-kit push` (drizzle-kit 0.31.10) needs to add a UNIQUE constraint to a
table that already has rows, it shows an interactive prompt: "…contains N items. If
this statement fails… Do you want to truncate <table>?". In any non-TTY context
(post-merge script, CI, piped shell) it throws `Interactive prompts require a TTY
terminal` and aborts.

**The `--force` flag does NOT skip this particular prompt** — `push --force` still
tries to render it and fails the same way. So `pnpm --filter db run push-force` is
not a fix for this case.

**How to apply safely:** first verify there are no duplicate NON-NULL values for the
column (Postgres allows multiple NULLs under a unique constraint, so all-NULL columns
are always safe). Then apply the constraint with raw SQL instead of push:
`ALTER TABLE <t> ADD CONSTRAINT <t>_<col>_unique UNIQUE (<col>);`
Once the DB matches the schema, future `push` runs see no diff and won't prompt.

**Why:** `scripts/post-merge.sh` runs `pnpm --filter db push`; this prompt silently
breaks the post-merge migration for any newly-added unique constraint.

**How to apply (production strategy):** prefer `drizzle-kit generate` (SQL migration
files) + `drizzle-kit migrate` for idempotent, non-interactive production migrations
rather than `push`. Avoid `push --force` against prod — it can drop data.
