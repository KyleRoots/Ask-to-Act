import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "stripe-replit-sync";
import {
  getStripeSync,
  getUncachableStripeClient,
} from "./lib/stripe/stripeClient.js";
import { ensureColumns } from "./lib/ensure-columns.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function initStripe(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.warn("DATABASE_URL not set — skipping Stripe initialization");
    return;
  }

  try {
    await runMigrations({ databaseUrl });
  } catch (err: unknown) {
    logger.warn({ err }, "Stripe migrations failed — skipping billing initialization");
    return;
  }

  // Pre-validate Stripe credentials with a lightweight balance call before
  // creating StripeSync. StripeSync logs internally at ERROR level when its
  // own getAccountId call fails; by bailing out here first we keep startup
  // logs clean when Stripe isn't fully configured.
  try {
    const stripeClient = await getUncachableStripeClient();
    await stripeClient.balance.retrieve();
  } catch (err: unknown) {
    logger.warn(
      { err },
      "Stripe not connected — subscription gate will not enforce billing. Connect Stripe integration to enable.",
    );
    return;
  }

  try {
    const stripeSync = await getStripeSync();
    const domain = process.env.REPLIT_DOMAINS?.split(",")[0];
    if (domain) {
      await stripeSync.findOrCreateManagedWebhook(
        `https://${domain}/api/stripe/webhook`,
      );
    }
    // Backfill runs async — don't block server startup
    stripeSync.syncBackfill().catch((err: unknown) => {
      logger.warn({ err }, "Stripe backfill failed");
    });
    logger.info("Stripe initialized");
  } catch (err: unknown) {
    logger.warn({ err }, "Stripe webhook/sync setup failed");
  }
}

await ensureColumns();
await initStripe();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
