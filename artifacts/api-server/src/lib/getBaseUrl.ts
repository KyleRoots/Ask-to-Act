/**
 * Returns the correct base URL for constructing absolute links (enrollment,
 * Stripe success/cancel, etc.) in all environments:
 *
 *  - Production deploy  → the first REPLIT_DOMAINS entry  (e.g. connect.asktoact.ai)
 *  - Replit dev preview → REPLIT_DEV_DOMAIN               (public dev proxy)
 *  - Pure local dev     → http://localhost:<PORT>
 */
export function getBaseUrl(): string {
  if (process.env.NODE_ENV === "production" && process.env.REPLIT_DOMAINS) {
    return `https://${process.env.REPLIT_DOMAINS.split(",")[0]}`;
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  }
  return `http://localhost:${process.env.PORT ?? 8080}`;
}
