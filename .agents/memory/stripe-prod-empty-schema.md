---
name: Stripe prod empty-schema startup ERROR
description: Why prod logs "relation stripe.accounts does not exist" with an empty stripe schema, the REAL bundling root cause, and the build-time fix (NOT a DB drop).
---

# Stripe empty-schema trap in production

## Symptom
At deploy startup / first Stripe-touching request, prod logs an `ERROR` with pg
code `42P01` `relation "stripe.accounts" does not exist` (stack through
`StripeSync.getAccountId*` / `findOrCreateManagedWebhook` / `upsertAccount`). App
is otherwise healthy (caught in initStripe try/catch; server still listens,
health 200). The prod `stripe` schema EXISTS but contains ZERO tables (dev has
the full set).

## REAL root cause (the bundling trap)
`stripe-replit-sync`'s `runMigrations()` finds its SQL migration files via
`path.resolve(dirname(import.meta.url), "./migrations")`. api-server is bundled
by esbuild (`build.mjs`) into a single `dist/index.mjs` with the package INLINED.
So at runtime that path resolves to `<distDir>/migrations` — which esbuild does
NOT emit. `connectAndMigrate` then hits `fs.existsSync(migrationsDirectory) ===
false` and **silently returns** ("Migrations directory not found, skipping").
Result: `CREATE SCHEMA IF NOT EXISTS stripe` runs (empty schema appears) but no
tables are ever created. Library migration tracking lives INSIDE the schema
(`stripe._migrations`), so it is not the culprit.

**Why dev hid it:** the dev DB already had the tables from an earlier run, so the
silent skip had no visible effect there.

## Why "DROP SCHEMA stripe CASCADE + redeploy" does NOT fix it
Dropping the schema and redeploying just recreates the SAME empty schema, because
the redeployed bundle still lacks the migration files. Confirmed empirically:
after a clean drop + redeploy the schema came back with 0 tables and 42P01
returned. Do not recommend the DB-drop path as the fix.

## The fix (build-time, durable)
In `artifacts/api-server/build.mjs`, after the esbuild step, copy the package's
migrations next to the bundle so the runtime lookup resolves:
`cp(resolve(dirname(require.resolve("stripe-replit-sync")), "migrations"),
resolve(distDir, "migrations"), {recursive:true})`. Then rebuild + redeploy. On
boot, `runMigrations` finds the files and `migrate()` creates `stripe._migrations`
plus all tables — even into a pre-existing empty schema (no manual DB drop
needed).

**General lesson:** any bundled dependency that loads sibling files via
`import.meta.url`/`__dirname` (migrations, .proto, .wasm, templates) will break
under esbuild bundling — either mark it `external` or copy its data files next to
the output in the build.

## How to diagnose fast
`executeSql({ environment:"production", sqlQuery:"SELECT table_name FROM
information_schema.tables WHERE table_schema='stripe'" })` — empty result +
schema present in `information_schema.schemata` = this trap. Then check the built
bundle: `ls artifacts/api-server/dist/migrations` (missing = the bug).

## Impact (assess before alarming the user)
Usually cosmetic until billing is live. `resolveFirmStatus` reads cached
`firms.subscription_status` and only falls back to `stripe.subscriptions` when a
firm has a `stripe_subscription_id` (wrapped in try/catch → null). Real
degradation = managed Stripe webhook can't be created and Stripe events can't
persist, so `firms.subscription_status` won't auto-update. No functional impact
if no firm has a `stripe_subscription_id` yet.
