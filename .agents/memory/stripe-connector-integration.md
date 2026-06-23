---
name: Stripe Replit connector integration
description: How to fetch Stripe credentials from the Replit connector proxy, and how to run stripe-replit-sync migrations correctly.
---

# Stripe Replit Connector Integration

## Credential fetch

The Replit connector proxy serves credentials at:
```
https://${REPLIT_CONNECTORS_HOSTNAME}/api/v2/connection?include_secrets=true&connector_names=stripe
```

Auth header must be: `"X-Replit-Token": "repl " + process.env.REPL_IDENTITY`
(NOT `X_REPLIT_TOKEN` — underscores are wrong; HTTP headers use hyphens)

The response shape is:
```json
{
  "items": [{
    "settings": {
      "secret": "sk_test_...",       ← NOT "secret_key"
      "publishable": "pk_test_...",
      "mcp": "ek_test_...",
      "account_id": "acct_..."
    }
  }]
}
```

Key field is `settings.secret` (NOT `settings.secret_key`).

**Why:** Replit's Stripe connector uses its own settings schema. The field name `secret` differs from what Stripe's own docs call it (`secret_key`). This cost one debug cycle.

## stripe-replit-sync migrations

`runMigrations` from `stripe-replit-sync` takes `{ databaseUrl, ssl?, logger? }` only.
- Do NOT pass `schema: "stripe"` — the library hardcodes schema to `"stripe"` internally (extra fields are silently ignored but can cause TypeScript complaints)
- Must be called BEFORE `new StripeSync(...)` — otherwise `stripe.accounts` table won't exist
- Safe to call on every startup (idempotent)

```ts
import { runMigrations } from "stripe-replit-sync";
await runMigrations({ databaseUrl });
const stripeSync = new StripeSync({ ... });
```

**Why:** The library creates the `stripe` schema and all its tables. Without this, StripeSync throws `relation "stripe.accounts" does not exist`.

## Stripe product seed script

Located at `scripts/src/seed-products.ts`. Run with:
```
pnpm --filter @workspace/scripts exec tsx src/seed-products.ts
```
Idempotent — uses `stripe.products.search` before creating. Creates:
- AskToAct Platform: $499/mo + $4,990/yr
- AskToAct Active Seat: $29/mo
- AskToAct Additional Connector: $299/mo

## Integration lifecycle

After `proposeIntegration` (OAuth flow), must call `addIntegration` with the `connection:...` ID to bind the project. If `connectionAlreadyAdded: true`, the binding is active — proceed directly to runtime use.
