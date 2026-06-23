/**
 * Returns the correct base URL for constructing absolute links (enrollment,
 * Stripe success/cancel, etc.) in all environments:
 *
 *  - Production deploy  → PROD_URL env (e.g. https://connect.asktoact.ai)
 *                         Falls back to first REPLIT_DOMAINS entry if unset
 *  - Replit dev preview → REPLIT_DEV_DOMAIN (public dev proxy)
 *  - Pure local dev     → http://localhost:<PORT>
 *
 * PROD_URL is checked first in production so the branded custom domain is
 * always used instead of the raw *.replit.app deploy host.
 */
export function getBaseUrl(): string {
  if (process.env.NODE_ENV === "production") {
    if (process.env.PROD_URL) return process.env.PROD_URL;
    if (process.env.REPLIT_DOMAINS) return `https://${process.env.REPLIT_DOMAINS.split(",")[0]}`;
    return "https://connect.asktoact.ai";
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  }
  return `http://localhost:${process.env.PORT ?? 8080}`;
}
