import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();
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
app.use(cors());
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

app.get("/", (_req, res) => {
  res.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Myticas AI Connector</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0b1020;color:#e8ecf3;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    main{max-width:480px;text-align:center}
    .logo{font-size:13px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:#4f6ef7;margin-bottom:32px}
    h1{font-size:26px;font-weight:600;margin-bottom:16px;line-height:1.3}
    p{font-size:15px;line-height:1.65;color:#8a99b3}
    .divider{width:40px;height:2px;background:#1e2a45;margin:28px auto}
    .note{font-size:13px;color:#4a566e;margin-top:24px}
  </style>
</head>
<body>
  <main>
    <div class="logo">Myticas Consulting</div>
    <h1>AI Connector</h1>
    <div class="divider"></div>
    <p>This is a private API service that connects Myticas recruiters to their AI tools. It is not a public website.</p>
    <p class="note">Authorized personnel only. If you are a Myticas recruiter, your administrator will provide your enrollment link.</p>
  </main>
</body>
</html>`);
});

app.use("/api", router);

export default app;
