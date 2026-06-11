import { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function extractProvidedToken(req: Request): string | null {
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }

  const pathToken = req.params["token"];
  if (typeof pathToken === "string" && pathToken.length > 0) {
    return pathToken;
  }

  const queryToken = req.query["key"] ?? req.query["token"];
  if (typeof queryToken === "string" && queryToken.length > 0) {
    return queryToken;
  }

  return null;
}

export function bearerAuth(req: Request, res: Response, next: NextFunction) {
  const token = process.env["MCP_BEARER_TOKEN"];

  if (!token) {
    res.status(503).json({
      error: "Server misconfiguration: MCP_BEARER_TOKEN is not set",
    });
    return;
  }

  const provided = extractProvidedToken(req);
  if (!provided) {
    res.status(401).json({
      error:
        "Missing credentials. Provide the token via 'Authorization: Bearer <token>' header, a '/mcp/<token>' path, or a '?key=<token>' query parameter.",
    });
    return;
  }

  if (!safeEqual(provided, token)) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  next();
}
