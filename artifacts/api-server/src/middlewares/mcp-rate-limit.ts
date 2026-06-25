import { type Request } from "express";
import { createHash } from "node:crypto";
import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from "express-rate-limit";

/**
 * Rate-limit key for the MCP endpoint.
 *
 * MCP traffic from ChatGPT/Claude arrives from the AI vendor's shared server
 * IPs, so an IP-keyed limit would throttle ALL tenants together (one busy firm
 * could rate-limit everyone). Key by the caller's bearer token instead, hashed
 * with SHA-256 so the secret is never used as a map key, giving each connector
 * its own budget. Falls back to an IPv6-safe IP key for token-less requests
 * (which bearerAuth will reject with 401 anyway, but we still want them bounded).
 *
 * Mounted via app.use("/api/mcp", ...), so the path-token form
 * (/api/mcp/<token>) surfaces as the first non-empty segment of req.path.
 */
export function mcpRateLimitKey(req: Request): string {
  const authHeader = req.headers["authorization"];
  let token: string | null = null;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice("Bearer ".length).trim();
  } else {
    const seg = req.path.split("/").find((s) => s.length > 0);
    if (seg) {
      try {
        token = decodeURIComponent(seg);
      } catch {
        token = seg;
      }
    }
  }
  if (token) {
    return "mcp-tok:" + createHash("sha256").update(token).digest("hex");
  }
  return "mcp-ip:" + ipKeyGenerator(req.ip ?? "");
}

// Per-token budget. Defaults are generous enough for heavy AI tool-call bursts
// (each token gets its OWN window) while still bounding the 25mb-body DoS
// surface, since this limiter runs BEFORE the body is parsed. Tunable via env.
const MCP_RATE_LIMIT_MAX = Number(process.env["MCP_RATE_LIMIT_MAX"] ?? 120);
const MCP_RATE_LIMIT_WINDOW_MS = Number(
  process.env["MCP_RATE_LIMIT_WINDOW_MS"] ?? 60_000,
);

export const mcpLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: MCP_RATE_LIMIT_WINDOW_MS,
  max: MCP_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: mcpRateLimitKey,
  message: { error: "Too many requests, please try again shortly." },
});
