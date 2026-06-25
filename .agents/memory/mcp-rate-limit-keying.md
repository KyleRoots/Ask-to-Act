---
name: MCP rate limit keying
description: Why the MCP limiter keys by hashed token (not IP) and mounts before the large JSON body parser.
---

# MCP rate limit keying

The `/api/mcp` (+ `/api/mcp/:token`) endpoints have a dedicated rate limiter,
separate from the global API limiter.

- **Key by a SHA-256 hash of the Bearer / path token**, never the raw token, and
  never the IP for the primary key. Fall back to express-rate-limit's
  `ipKeyGenerator` only when no token is present.
  **Why:** ChatGPT/Claude connectors all egress from a small shared pool of
  cloud IPs. Keying by IP would let one tenant's traffic throttle every other
  tenant. The per-tenant identity is the token, so that must be the key.
- **Mount the limiter BEFORE the 25mb JSON body parser.**
  **Why:** the MCP door accepts large bodies; counting/rejecting before parsing
  bounds large-body DoS instead of parsing 25mb only to 429 afterward.
- The **global** API limiter must `skip` paths starting with `/api/mcp` so the
  two limiters don't double-count or conflict.
- Tunables: `MCP_RATE_LIMIT_MAX` (default 120), `MCP_RATE_LIMIT_WINDOW_MS`
  (default 60000).
