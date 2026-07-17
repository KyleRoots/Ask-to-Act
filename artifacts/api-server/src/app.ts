import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { mcpLimiter } from "./middlewares/mcp-rate-limit";
import { cspNonceMiddleware, nonceAttr } from "./lib/csp-nonce";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import legalRouter from "./routes/legal";
import { logger } from "./lib/logger";
import { mountFrontends } from "./lib/serve-frontends";
import { isSentryEnabled, Sentry } from "./lib/sentry.js";

const app: Express = express();
app.set("trust proxy", 1);

// Clerk FAPI proxy — must be before body parsers (streams raw bytes)
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// First-party SPAs (portal, admin) + protected GTM pages (exec-summary, pitch-deck).
// GTM mounts use HTTP Basic Auth in production — see gtm-materials-gate.ts.
mountFrontends(app);

app.get("/robots.txt", (_req, res) => {
  res.type("text/plain");
  res.send(
    [
      "User-agent: *",
      "Disallow: /exec-summary",
      "Disallow: /pitch-deck",
      "",
    ].join("\n"),
  );
});

// Per-request CSP nonce — MUST run before helmet so res.locals.cspNonce exists
// when helmet builds the Content-Security-Policy header, and so the downstream
// HTML builders (page(), connectorSetupPage(), legalPage(), landing) can read
// the same nonce via nonceAttr().
app.use(cspNonceMiddleware);

// Security headers (helmet). Applied AFTER the Clerk FAPI proxy so Clerk's
// proxied frontend-API responses are left untouched. This app serves only its
// own self-contained HTML pages (landing, legal, enroll/connector/OAuth) plus
// the JSON /api — it does NOT serve the portal/admin SPAs.
//
// CSP: inline <script>/<style> are allowed ONLY via a per-request nonce, so
// 'unsafe-inline' is dropped from script-src, script-src-attr and style-src.
// Inline event handlers were refactored to addEventListener so script-src-attr
// is 'none'. style-src-attr keeps 'unsafe-inline' for a few benign inline
// style="" attributes (CSS can't execute script; all dynamic content is escaped).
const cspNonce = (_req: unknown, res: unknown): string =>
  `'nonce-${(res as express.Response).locals.cspNonce}'`;
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", cspNonce],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", cspNonce],
        styleSrcAttr: ["'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: [],
      },
    },
    // The JSON API may be read cross-origin by first-party tools; helmet's
    // default same-origin CORP would block legitimate cross-origin reads.
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Restrict cross-origin browser access to known first-party origins. Non-browser
// callers (curl, server-to-server MCP from ChatGPT/Claude) send no Origin header
// and are always allowed. Extra origins can be added via ALLOWED_ORIGINS (CSV).
const explicitOrigins = (process.env["ALLOWED_ORIGINS"] ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function isAllowedOrigin(origin: string): boolean {
  if (explicitOrigins.includes(origin)) return true;
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname === "127.0.0.1") return true;
  // First-party production origins (custom domain in all its forms).
  if (hostname === "asktoact.ai" || hostname.endsWith(".asktoact.ai")) {
    return true;
  }
  // Replit-hosted origins (*.replit.dev / *.replit.app / *.repl.co) are trusted
  // ONLY outside production. In production every first-party SPA (portal/admin)
  // is served same-origin under connect.asktoact.ai via path routing, so no
  // Replit origin is a legitimate cross-origin caller — and allowing the broad
  // *.replit.app / *.repl.co would let ANY Replit-deployed app make credentialed
  // cross-origin reads against a logged-in user. Extra prod origins, if ever
  // needed, go through the ALLOWED_ORIGINS env allowlist above.
  if (process.env.NODE_ENV !== "production") {
    return (
      hostname.endsWith(".replit.dev") ||
      hostname.endsWith(".replit.app") ||
      hostname.endsWith(".repl.co")
    );
  }
  return false;
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, isAllowedOrigin(origin));
    },
  }),
);

// Stripe webhook — must be registered BEFORE express.json() so body stays as raw Buffer
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature) {
      res.status(400).json({ error: "Missing stripe-signature" });
      return;
    }
    try {
      const sig = Array.isArray(signature) ? signature[0] : signature;
      const { WebhookHandlers } = await import(
        "./lib/stripe/webhookHandlers.js"
      );
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      res.status(200).json({ received: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, "Stripe webhook error");
      res.status(400).json({ error: "Webhook processing error" });
    }
  },
);

// Rate limiting is registered BEFORE the body parsers so abusive requests are
// throttled before any large body is read/allocated (DoS protection). The
// Stripe webhook above is intentionally registered earlier so it is never
// rate-limited or affected by these parsers.
const maxRequestsPerWindow = Number(process.env["RATE_LIMIT_MAX"] ?? 120);
const windowMs = Number(process.env["RATE_LIMIT_WINDOW_MS"] ?? 60_000);

app.use(
  rateLimit({
    windowMs,
    max: maxRequestsPerWindow,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
    // /api/mcp is governed by its own per-token limiter (mcpLimiter) below.
    // Skipping it here is essential: MCP requests come from ChatGPT/Claude's
    // shared egress IPs, so this IP-keyed global limiter would otherwise let one
    // busy firm throttle every tenant at once.
    skip: (req) => req.path.startsWith("/api/mcp"),
  }),
);

// The MCP endpoint is the ONLY route that receives file uploads: file-upload
// tools (résumé parse, file attachments) send the file as a base64 string
// inside the JSON body, and base64 inflates bytes by ~33%. Express's 100kb
// default silently 413s any real document (a 161KB .docx → ~215KB base64), so
// allow a generous 25mb — but ONLY here, to limit DoS attack surface. This
// parser sets req._body, so the global parser below skips already-parsed
// requests. Matches /api/mcp and /api/mcp/:token.
// Per-token rate limit, registered BEFORE the 25mb parser so abusive requests
// are rejected before any large body is read/allocated (DoS protection). Keyed
// by bearer token, not the shared AI-vendor IP (see mcp-rate-limit.ts).
app.use("/api/mcp", mcpLimiter);
app.use("/api/mcp", express.json({ limit: "25mb" }));

// Global body parsers for every other route. Kept small (1mb) since no other
// endpoint accepts file payloads.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Clerk session auth — populates getAuth(req) for portal endpoints. Resolves
// the publishable key from the request host so multi-domain/custom-domain
// flows work; falls back to CLERK_PUBLISHABLE_KEY otherwise.
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/", (_req, res) => {
  res.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AskToAct</title>
  <style${nonceAttr()}>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0b1020;color:#e8ecf3;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    main{max-width:480px;text-align:center}
    .logo{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:32px}
    .logo-text{font-size:18px;font-weight:800;letter-spacing:-0.02em;color:#f8fafc}
    .logo-text span{color:#38BDF8}
    h1{font-size:26px;font-weight:600;margin-bottom:16px;line-height:1.3}
    p{font-size:15px;line-height:1.65;color:#8a99b3}
    .divider{width:40px;height:2px;background:#1e2a45;margin:28px auto}
    .note{font-size:13px;color:#4a566e;margin-top:24px}
  </style>
</head>
<body>
  <main>
    <div class="logo">
      <svg width="32" height="32" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#4338CA"/><stop offset="55%" stop-color="#4F46E5"/><stop offset="100%" stop-color="#0EA5E9"/></linearGradient></defs><rect width="48" height="48" rx="13" fill="url(#g)"/><path d="M11 5 C11 3.3 12.3 2 14 2 L34 2 C35.7 2 37 3.3 37 5 L37 27 C37 28.7 35.7 30 34 30 L27.5 30 L24 36.5 L20.5 30 L14 30 C12.3 30 11 28.7 11 27 Z" fill="white" fill-opacity="0.97"/><line x1="15.5" y1="16" x2="29.5" y2="16" stroke="#4338CA" stroke-width="3" stroke-linecap="round"/><polyline points="25,11 31,16 25,21" fill="none" stroke="#4338CA" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="logo-text">Ask<span>To</span>Act</span>
    </div>
    <h1>AI Action Layer for Recruiting</h1>
    <div class="divider"></div>
    <p>This is a private API service. It connects authorized recruiters to their AI tools — so they can work inside their ATS directly from ChatGPT or Claude.</p>
    <p class="note">Authorized personnel only. Your administrator will provide your personal enrollment link.</p>
  </main>
</body>
</html>`);
});

// Public legal pages (Privacy, Terms) — served at the root for clean URLs
// (e.g. connect.asktoact.ai/privacy) so they can be linked publicly and from
// the admin/portal footers.
app.use(legalRouter);

app.use("/api", router);

// Sentry Express error handler — MUST sit before our own handler so it can
// capture the exception while still letting the next middleware format the
// client response. No-op when SENTRY_DSN is unset.
if (isSentryEnabled()) {
  Sentry.setupExpressErrorHandler(app);
}

// Global error handler. Express 5 forwards rejected async handlers here, which
// keeps the process alive and prevents stack traces from leaking to clients.
app.use(
  (
    err: Error & { status?: number; statusCode?: number },
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    void _next;
    logger.error(
      { err, reqId: (req as express.Request & { id?: string }).id },
      "Unhandled request error",
    );
    if (res.headersSent) return;
    const status = err.status ?? err.statusCode ?? 500;
    res.status(status).json({ error: "Internal server error" });
  },
);

export default app;
