#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Apply schema changes to the merged environment's database. `drizzle-kit push`
# is interactive when a change needs a data decision (e.g. adding a UNIQUE to a
# populated table) and will error in this non-TTY context. Don't fail the whole
# merge on it — surface a warning so the change can be applied manually.
# Production migrations should use `drizzle-kit generate` + `migrate` instead.
pnpm --filter db push || echo "WARN: 'db push' did not complete (likely a schema change needing manual review). Apply pending schema changes by hand — see .agents/memory/drizzle-push-unique-constraint-tty.md"
