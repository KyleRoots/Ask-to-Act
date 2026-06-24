---
name: Stripe prod empty-schema startup ERROR
description: Why prod logs a scary "relation stripe.accounts does not exist" at startup even though runMigrations runs, and the correct remedy.
---

# Stripe empty-schema trap in production

## Symptom
At deploy startup, prod logs an `ERROR` with pg code `42P01` `relation "stripe.accounts" does not exist`, stack = `initStripe → StripeSync.findOrCreateManagedWebhook → getAccountId → upsertAccount`. App is otherwise healthy (error is caught at the `initStripe` try/catch and logged as warn "Stripe webhook/sync setup failed"; server still listens, health 200).

## Root cause
The `stripe` schema EXISTS in the prod DB but contains ZERO tables (dev has the full ~29 `stripe-replit-sync` tables). Because the schema already exists, `runMigrations({databaseUrl})` does NOT throw and does NOT recreate the tables — it no-ops on the existing-but-empty schema. So `initStripe` does not bail at the migrations step (no "Stripe migrations failed" warn), the Stripe credential `balance.retrieve()` precheck passes (Stripe IS connected), and then `findOrCreateManagedWebhook` is the first call to actually touch `stripe.accounts` → 42P01.

**Why it happens:** Replit's publish-time schema diff manages the Drizzle/public schema, NOT the runtime-created `stripe` schema. An early deploy left an empty `stripe` namespace in prod; on every later boot runMigrations sees the schema present and skips table creation.

## Impact (assess before alarming the user)
Usually cosmetic. `resolveFirmStatus` reads the cached `firms.subscription_status` (public column) and only falls back to `stripe.subscriptions` when a firm has a `stripe_subscription_id`; that fallback (`getSubscription`) is wrapped in try/catch returning null. So the subscription gate does NOT crash. Real degradation = the managed Stripe webhook isn't created and Stripe events can't be persisted, so `firms.subscription_status` won't auto-update. If no firm has a `stripe_subscription_id` yet (billing not live), there is no functional impact — only noisy startup logs.

## Remedy
Do NOT add startup DDL or custom migration scripts (database skill forbids it; `stripe.*` is read-only/blocked to the agent, prod is read-only via executeSql). The fix is a one-time prod operation the USER must run: drop the empty schema (`DROP SCHEMA stripe CASCADE`) in production, then redeploy so `runMigrations` rebuilds all tables cleanly. Optional code hardening: before `findOrCreateManagedWebhook`, probe that `stripe.accounts` exists and skip+warn if not, to keep startup logs clean.

## How to diagnose fast
`executeSql({ environment:"production", sqlQuery:"SELECT table_name FROM information_schema.tables WHERE table_schema='stripe'" })` — empty result + schema present in `information_schema.schemata` = this exact trap.
