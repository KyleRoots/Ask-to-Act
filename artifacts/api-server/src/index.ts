import app from "./app";
import { logger } from "./lib/logger";
import { runMigrations } from "stripe-replit-sync";
import { runAppMigrations } from "@workspace/db/run-migrations";
import {
  getStripeSync,
  getUncachableStripeClient,
} from "./lib/stripe/stripeClient.js";
import { ensureColumns } from "./lib/ensure-columns.js";
import { getBaseUrl } from "./lib/getBaseUrl.js";

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

// Fail fast on missing critical configuration. In production a missing secret
// (e.g. TOKEN_ENCRYPTION_KEY, without which Bullhorn refresh tokens would be
// stored in plaintext) must stop startup rather than silently degrade. In
// development we only warn so local work isn't blocked.
const REQUIRED_ENV = [
  "DATABASE_URL",
  "MCP_BEARER_TOKEN",
  "TOKEN_ENCRYPTION_KEY",
  "CLERK_SECRET_KEY",
  "BULLHORN_CLIENT_ID",
  "BULLHORN_CLIENT_SECRET",
] as const;

const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  const message = `Missing required environment variables: ${missingEnv.join(", ")}`;
  if (process.env.NODE_ENV === "production") {
    throw new Error(message);
  }
  logger.warn(`${message} — continuing in degraded mode (development only).`);
}

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection");
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — exiting");
  process.exit(1);
});

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
    // Register the webhook against the app's real public base URL. In
    // production this is PROD_URL (e.g. https://connect.asktoact.ai); on Replit
    // dev it uses REPLIT_DEV_DOMAIN. We skip auto-registration for local
    // (non-https) URLs since Stripe cannot reach them.
    const baseUrl = getBaseUrl();
    if (baseUrl.startsWith("https://")) {
      await stripeSync.findOrCreateManagedWebhook(
        `${baseUrl}/api/stripe/webhook`,
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

// Retry DB setup up to 3 times with a short backoff to survive Neon
// compute cold-starts (57P01 "terminating connection") during deployment.
function isTransientDbError(err: unknown): boolean {
  const code = (err as Record<string, unknown>)["code"];
  return code === "57P01" || code === "ECONNRESET" || code === "ECONNREFUSED";
}

async function runAppMigrationsWithRetry(maxAttempts = 3, delayMs = 2000): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await runAppMigrations();
      if (result.applied.length > 0) {
        logger.info({ applied: result.applied }, "Database migrations applied");
      } else {
        logger.info("Database migrations up to date");
      }
      return;
    } catch (err) {
      if (attempt < maxAttempts && isTransientDbError(err)) {
        logger.warn({ err, attempt }, `runAppMigrations attempt ${attempt} failed — retrying in ${delayMs}ms`);
        await new Promise((res) => setTimeout(res, delayMs));
        continue;
      }
      logger.error({ err }, "Database migrations failed");
      if (process.env.NODE_ENV === "production") {
        throw err;
      }
      logger.warn("Continuing without migrations (development only)");
      return;
    }
  }
}

async function ensureColumnsWithRetry(maxAttempts = 3, delayMs = 2000): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await ensureColumns();
      return;
    } catch (err) {
      if (attempt < maxAttempts && isTransientDbError(err)) {
        logger.warn({ err, attempt }, `ensureColumns attempt ${attempt} failed — retrying in ${delayMs}ms`);
        await new Promise((res) => setTimeout(res, delayMs));
      } else {
        logger.error({ err }, "ensureColumns failed after all attempts");
        if (process.env.NODE_ENV === "production") {
          throw err;
        }
      }
    }
  }
}

await runAppMigrationsWithRetry();
await ensureColumnsWithRetry();
await initStripe();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
