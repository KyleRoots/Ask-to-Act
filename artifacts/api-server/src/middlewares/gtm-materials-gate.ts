import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function parseBasicAuth(
  header: string | undefined,
): { user: string; pass: string } | null {
  if (!header?.startsWith("Basic ")) {
    return null;
  }
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep < 0) {
      return null;
    }
    return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

/**
 * Protects internal GTM surfaces (exec-summary, pitch-deck).
 *
 * - Production without GTM_MATERIALS_PASSWORD → 404 (fail closed).
 * - Production with password → HTTP Basic Auth (share user/pass to grant access).
 * - GTM_MATERIALS_PUBLIC=true → bypass (dev/emergency only).
 * - Non-production without password → allow (local preview).
 *
 * GTM playbook (.agents/memory/) is never web-served — repo access only.
 */
export function gtmMaterialsGate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet");

  if (process.env.GTM_MATERIALS_PUBLIC === "true") {
    next();
    return;
  }

  const password = process.env.GTM_MATERIALS_PASSWORD;
  const expectedUser = process.env.GTM_MATERIALS_USER ?? "asktoact";

  if (!password) {
    if (process.env.NODE_ENV === "production") {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    next();
    return;
  }

  const creds = parseBasicAuth(req.headers.authorization);
  if (
    creds &&
    safeEqual(creds.user, expectedUser) &&
    safeEqual(creds.pass, password)
  ) {
    next();
    return;
  }

  res.setHeader(
    "WWW-Authenticate",
    'Basic realm="AskToAct GTM Materials", charset="UTF-8"',
  );
  res.status(401).type("text/plain").send("Authentication required.");
}
