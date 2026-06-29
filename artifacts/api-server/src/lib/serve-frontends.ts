import express, { type Express, type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

/**
 * Serves the built first-party single-page apps (customer portal, super-admin
 * dashboard) and static marketing pages under their path prefixes, mirroring
 * the Replit application-router topology so everything lives on one domain.
 *
 * These are mounted BEFORE the api-server's own strict nonce-based CSP: Vite /
 * React / Clerk bundles can't carry a per-request nonce, so they get a
 * SPA-appropriate CSP here instead. Each mount is skipped automatically if its
 * build output isn't present (e.g. local API-only dev), so this is a no-op on
 * Replit, where the router serves these apps separately.
 */

interface Frontend {
  prefix: string;
  dir: string;
}

const FRONTENDS: Frontend[] = [
  { prefix: "/portal", dir: "portal" },
  { prefix: "/admin", dir: "admin" },
  { prefix: "/exec-summary", dir: "exec-summary" },
  { prefix: "/pitch-deck", dir: "pitch-deck" },
];

// CSP suited to bundled SPAs: external 'self' scripts/styles plus the inline
// styles React/Radix inject at runtime, Clerk's same-origin proxied calls, and
// https/data images. Stricter than 'unsafe-eval'; no nonce required.
const spaSecurity = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "https:"],
      frameSrc: ["'self'", "https:"],
      workerSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginResourcePolicy: { policy: "same-origin" },
  crossOriginEmbedderPolicy: false,
});

function frontendsBaseDir(): string {
  if (process.env.FRONTENDS_DIR) {
    return process.env.FRONTENDS_DIR;
  }
  // In the bundled production build this file is dist/index.mjs, so its
  // directory is dist/ and the frontends are copied to dist/frontends/.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "frontends");
}

export function mountFrontends(app: Express): void {
  const baseDir = frontendsBaseDir();

  for (const { prefix, dir } of FRONTENDS) {
    const root = path.join(baseDir, dir);
    const indexHtml = path.join(root, "index.html");

    if (!fs.existsSync(indexHtml)) {
      logger.warn({ prefix, root }, "Frontend build not found — skipping mount");
      continue;
    }

    // Serve hashed static assets (long cache); index.html itself is revalidated.
    app.use(
      prefix,
      spaSecurity,
      express.static(root, {
        index: ["index.html"],
        maxAge: "1h",
        setHeaders(res, filePath) {
          if (filePath.endsWith("index.html")) {
            res.setHeader("Cache-Control", "no-cache");
          }
        },
      }),
    );

    // SPA fallback: client-side routes (no matching file) return index.html.
    app.use(prefix, spaSecurity, (req: Request, res: Response, next: NextFunction) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        next();
        return;
      }
      res.sendFile(indexHtml);
    });

    logger.info({ prefix, root }, "Mounted frontend");
  }
}
