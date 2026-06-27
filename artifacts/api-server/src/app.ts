import express, { type Express } from "express";
import cors, { type CorsOptions } from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Behind a hosting provider's proxy/load balancer (Railway, Render, Fly, etc.)
// the client IP arrives in X-Forwarded-For. Trust the first proxy hop so the
// rate limiter keys off the real client IP instead of the proxy's address.
app.set("trust proxy", 1);

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

// Security headers. This is an API server whose only HTML is the small Bullhorn
// auth status/result pages, which use an inline <style> block — so the CSP
// allows inline styles but otherwise keeps Helmet's secure defaults.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "style-src": ["'self'", "'unsafe-inline'"],
      },
    },
  }),
);

// Cross-origin access control. The MCP and v1 surfaces are called server-to-
// server (ChatGPT Enterprise, etc.), which is unaffected by CORS. Browser-based
// clients are opt-in via CORS_ALLOWED_ORIGINS (comma-separated). Default: no
// cross-origin browser access. Set to "*" only if you explicitly want any
// origin (not recommended for production).
const corsOrigins = (process.env["CORS_ALLOWED_ORIGINS"] ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter((o) => o.length > 0);

const corsOptions: CorsOptions =
  corsOrigins.length === 0
    ? { origin: false }
    : corsOrigins.includes("*")
      ? { origin: true }
      : { origin: corsOrigins };

app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

app.use("/api", router);

export default app;
