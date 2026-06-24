#!/bin/bash
set -e
pnpm install --frozen-lockfile
# Generate any new migration files for schema changes made in this merge, then
# apply all pending migrations non-interactively. Unlike `drizzle-kit push`,
# this never hangs on an interactive prompt (e.g. adding a UNIQUE constraint to
# a populated table) and fails with a non-zero exit code on any error so the
# problem is visible immediately.
pnpm --filter db generate
pnpm --filter db migrate
