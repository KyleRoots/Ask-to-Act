/**
 * Returns the correct base URL for constructing absolute links (enrollment,
 * Stripe success/cancel, etc.) in all environments:
 *
 *  - Production deploy  → PROD_URL env var (set to https://connect.asktoact.ai)
 *                         Falls back to hardcoded branded domain if unset.
 *                         NOTE: never falls back to REPLIT_DOMAINS in production
 *                         because that yields the raw *.replit.app host.
 *  - Replit dev preview → REPLIT_DEV_DOMAIN (public dev proxy)
 *  - Pure local dev     → http://localhost:<PORT>
 */
export function getBaseUrl(): string {
  if (process.env.NODE_ENV === "production") {
    return process.env.PROD_URL ?? "https://connect.asktoact.ai";
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  }
  return `http://localhost:${process.env.PORT ?? 8080}`;
}
