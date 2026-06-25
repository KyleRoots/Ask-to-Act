import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { type Request, type Response, type NextFunction } from "express";

/**
 * Per-request CSP nonce plumbing.
 *
 * To drop `'unsafe-inline'` from the script/style CSP, every legitimate inline
 * `<script>`/`<style>` must carry a per-request nonce that matches the one
 * advertised in the Content-Security-Policy header. The header is emitted by
 * helmet (which reads `res.locals.cspNonce`), while the HTML is produced by
 * plain string builders (page(), connectorSetupPage(), legalPage(), …) that
 * don't receive `res`. Threading a nonce argument through all ~20 call sites
 * would be noisy and error-prone, so the nonce is also stashed in an
 * AsyncLocalStorage the builders read via nonceAttr(). Both sources are set in
 * the SAME middleware, so they always agree for a given request.
 */
const nonceStore = new AsyncLocalStorage<string>();

export function cspNonceMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const nonce = randomBytes(16).toString("base64");
  res.locals.cspNonce = nonce;
  // Run the rest of the chain inside the ALS context so synchronous page
  // builders (and code across awaits) can read this request's nonce.
  nonceStore.run(nonce, () => next());
}

/** The current request's nonce, or "" outside a request (e.g. unit tests). */
export function currentNonce(): string {
  return nonceStore.getStore() ?? "";
}

/**
 * ` nonce="..."` attribute for inline <script>/<style> tags, or "" when there
 * is no active request nonce (so standalone rendering still produces valid HTML).
 */
export function nonceAttr(): string {
  const n = currentNonce();
  return n ? ` nonce="${n}"` : "";
}
