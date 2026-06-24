import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();
app.set("trust proxy", 1);

// Clerk FAPI proxy — must be before body parsers (streams raw bytes)
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

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
  return (
    hostname === "asktoact.ai" ||
    hostname.endsWith(".asktoact.ai") ||
    hostname.endsWith(".replit.dev") ||
    hostname.endsWith(".replit.app") ||
    hostname.endsWith(".repl.co")
  );
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

const maxRequestsPerWindow = Number(process.env["RATE_LIMIT_MAX"] ?? 120);
const windowMs = Number(process.env["RATE_LIMIT_WINDOW_MS"] ?? 60_000);

app.use(
  rateLimit({
    windowMs,
    max: maxRequestsPerWindow,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
  }),
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
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0b1020;color:#e8ecf3;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    main{max-width:480px;text-align:center}
    .logo{font-size:13px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#38bdf8;margin-bottom:32px}
    h1{font-size:26px;font-weight:600;margin-bottom:16px;line-height:1.3}
    p{font-size:15px;line-height:1.65;color:#8a99b3}
    .divider{width:40px;height:2px;background:#1e2a45;margin:28px auto}
    .note{font-size:13px;color:#4a566e;margin-top:24px}
  </style>
</head>
<body>
  <main>
    <div class="logo">AskToAct</div>
    <h1>AI Action Layer for Recruiting</h1>
    <div class="divider"></div>
    <p>This is a private API service. It connects authorized recruiters to their AI tools — so they can work inside their ATS directly from ChatGPT or Claude.</p>
    <p class="note">Authorized personnel only. Your administrator will provide your personal enrollment link.</p>
  </main>
</body>
</html>`);
});

app.use("/api", router);

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
