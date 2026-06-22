/**
 * AskToAct — Stripe product seed script
 *
 * Creates the billing products and prices in Stripe (test mode).
 * Safe to run multiple times — idempotent (checks before creating).
 *
 * Run with:
 *   pnpm --filter @workspace/scripts exec tsx src/seed-products.ts
 */

import { getUncachableStripeClient } from "./stripeClient.js";

async function seedProducts() {
  const stripe = await getUncachableStripeClient();
  console.log("Connected to Stripe. Seeding AskToAct products...\n");

  // ── Platform Plan ─────────────────────────────────────────────────────────
  // $499/mo — includes 1 ATS connector (Bullhorn) + admin tools + audit logs
  const existingPlatform = await stripe.products.search({
    query: "name:'AskToAct Platform' AND active:'true'",
  });

  let platformProductId: string;

  if (existingPlatform.data.length > 0) {
    platformProductId = existingPlatform.data[0].id;
    console.log(
      `✓ Platform product already exists: ${platformProductId}`,
    );
  } else {
    const platform = await stripe.products.create({
      name: "AskToAct Platform",
      description:
        "Base platform access: admin dashboard, audit logs, 1 ATS connector (Bullhorn) included.",
      metadata: { type: "platform" },
    });
    platformProductId = platform.id;

    await stripe.prices.create({
      product: platformProductId,
      unit_amount: 49900, // $499.00
      currency: "usd",
      recurring: { interval: "month" },
      nickname: "Platform monthly",
    });

    // Annual pricing — 2 months free ($499 × 10 = $4,990)
    await stripe.prices.create({
      product: platformProductId,
      unit_amount: 499000, // $4,990.00
      currency: "usd",
      recurring: { interval: "year" },
      nickname: "Platform annual (2 months free)",
    });

    console.log(`✓ Created Platform product: ${platformProductId}`);
    console.log("  Monthly: $499/mo | Annual: $4,990/yr (2 months free)");
  }

  // ── Per-Active-Seat ───────────────────────────────────────────────────────
  // $29/seat/mo — billed only when seat makes at least one AI call that month
  const existingSeat = await stripe.products.search({
    query: "name:'AskToAct Active Seat' AND active:'true'",
  });

  if (existingSeat.data.length > 0) {
    console.log(
      `✓ Active Seat product already exists: ${existingSeat.data[0].id}`,
    );
  } else {
    const seat = await stripe.products.create({
      name: "AskToAct Active Seat",
      description:
        "Per active recruiter seat. Only billed when the seat makes at least one AI call that month.",
      metadata: { type: "per_seat" },
    });

    await stripe.prices.create({
      product: seat.id,
      unit_amount: 2900, // $29.00
      currency: "usd",
      recurring: { interval: "month" },
      nickname: "Per active seat monthly",
    });

    console.log(`✓ Created Active Seat product: ${seat.id}`);
    console.log("  $29/seat/mo (active seats only)");
  }

  // ── Additional Connector ──────────────────────────────────────────────────
  // $299/mo — each ATS/CRM beyond the first (Salesforce, Workday, etc.)
  const existingConnector = await stripe.products.search({
    query: "name:'AskToAct Additional Connector' AND active:'true'",
  });

  if (existingConnector.data.length > 0) {
    console.log(
      `✓ Additional Connector product already exists: ${existingConnector.data[0].id}`,
    );
  } else {
    const connector = await stripe.products.create({
      name: "AskToAct Additional Connector",
      description:
        "Each ATS, CRM, or HRIS connector beyond the first included with Platform (Salesforce, Workday, Greenhouse, etc.).",
      metadata: { type: "connector" },
    });

    await stripe.prices.create({
      product: connector.id,
      unit_amount: 29900, // $299.00
      currency: "usd",
      recurring: { interval: "month" },
      nickname: "Additional connector monthly",
    });

    console.log(`✓ Created Additional Connector product: ${connector.id}`);
    console.log("  $299/mo per additional system");
  }

  console.log("\n✅ All products seeded. Webhooks will sync to database automatically.");
  console.log(
    "\nNext step: run POST /api/firms to create your first firm and get a checkout link.",
  );
}

seedProducts().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
