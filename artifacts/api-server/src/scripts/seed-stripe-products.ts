/**
 * Seed Stripe test-mode products for AskToAct.
 * Run once: pnpm --filter @workspace/api-server run seed:stripe
 *
 * Creates:
 *   - Product: "AskToAct Platform"  →  Price: $499 / month (flat)
 *   - Product: "AskToAct Per-Seat"  →  Price: $29 / seat / month (licensed quantity)
 *
 * Safe to re-run: checks for existing active prices before creating new ones.
 */

import Stripe from "stripe";

async function getStripeClient(): Promise<Stripe> {
  // Prefer a direct STRIPE_SECRET_KEY (Railway / any host); fall back to the
  // Replit connector when it isn't set.
  const directSecret = process.env.STRIPE_SECRET_KEY;
  if (directSecret) {
    return new Stripe(directSecret);
  }

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!hostname || !xReplitToken) {
    throw new Error(
      "Stripe is not configured. Set STRIPE_SECRET_KEY for direct hosting, " +
        "or connect the Stripe integration on Replit.",
    );
  }

  const resp = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=stripe`,
    {
      headers: { Accept: "application/json", "X-Replit-Token": xReplitToken },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!resp.ok) {
    throw new Error(`Failed to fetch Stripe credentials: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as {
    items?: Array<{ settings?: { secret?: string } }>;
  };
  const settings = data.items?.[0]?.settings;

  if (!settings?.secret) {
    throw new Error(
      "Stripe integration not connected or missing secret key. Connect Stripe via the Integrations tab.",
    );
  }

  return new Stripe(settings.secret as string);
}

async function upsertProduct(
  stripe: Stripe,
  name: string,
  description: string,
): Promise<Stripe.Product> {
  const existing = await stripe.products.search({ query: `name:'${name}' AND active:'true'` });
  if (existing.data.length > 0) {
    console.log(`  ✓ Product already exists: "${name}" (${existing.data[0].id})`);
    return existing.data[0];
  }
  const product = await stripe.products.create({ name, description });
  console.log(`  + Created product: "${name}" (${product.id})`);
  return product;
}

async function upsertPrice(
  stripe: Stripe,
  productId: string,
  unitAmount: number,
  nickname: string,
  recurring: { interval: "month" | "year"; usage_type?: "licensed" | "metered" },
): Promise<Stripe.Price> {
  const existing = await stripe.prices.search({
    query: `product:'${productId}' AND active:'true'`,
  });
  const match = existing.data.find(
    (p) =>
      p.unit_amount === unitAmount &&
      p.recurring?.interval === recurring.interval,
  );
  if (match) {
    console.log(`  ✓ Price already exists: ${nickname} ($${unitAmount / 100}/${recurring.interval}) → ${match.id}`);
    return match;
  }
  const price = await stripe.prices.create({
    product: productId,
    unit_amount: unitAmount,
    currency: "usd",
    nickname,
    recurring: {
      interval: recurring.interval,
      usage_type: recurring.usage_type ?? "licensed",
    },
  });
  console.log(`  + Created price: ${nickname} ($${unitAmount / 100}/${recurring.interval}) → ${price.id}`);
  return price;
}

async function main() {
  console.log("\n🔑  Connecting to Stripe…");
  const stripe = await getStripeClient();

  const acct = await (
    stripe.accounts as unknown as {
      retrieve(): Promise<{ testmode?: boolean }>;
    }
  ).retrieve();
  const isTest = acct.testmode !== false;
  console.log(`\n✅  Connected to Stripe (${isTest ? "TEST" : "LIVE"} mode)\n`);

  console.log("📦  Platform Plan — AskToAct Platform");
  const platform = await upsertProduct(
    stripe,
    "AskToAct Platform",
    "Remote MCP connector for AI-to-Bullhorn integration. Flat monthly fee covers one firm.",
  );
  const platformPrice = await upsertPrice(stripe, platform.id, 49900, "Platform Plan $499/mo", {
    interval: "month",
  });

  console.log("\n📦  Per-Seat Add-On — AskToAct Per-Seat");
  const perSeat = await upsertProduct(
    stripe,
    "AskToAct Per-Seat",
    "Per-recruiter seat add-on billed monthly. Add one unit per enrolled recruiter above the base plan.",
  );
  const perSeatPrice = await upsertPrice(stripe, perSeat.id, 2900, "Per-Seat $29/mo", {
    interval: "month",
    usage_type: "licensed",
  });

  console.log("\n🎉  Done!\n");
  console.log("Platform Plan price ID (use in checkout): ", platformPrice.id);
  console.log("Per-Seat add-on price ID:                 ", perSeatPrice.id);
  console.log(
    "\nThe admin portal will now generate Stripe checkout URLs when you create a new firm.",
  );
}

main().catch((err) => {
  console.error("\n❌ Seed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
