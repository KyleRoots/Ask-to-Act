import { Request, Response, NextFunction } from "express";

export function bearerAuth(req: Request, res: Response, next: NextFunction) {
  const token = process.env["MCP_BEARER_TOKEN"];

  if (!token) {
    res.status(503).json({
      error: "Server misconfiguration: MCP_BEARER_TOKEN is not set",
    });
    return;
  }

  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const provided = authHeader.slice("Bearer ".length).trim();
  if (provided !== token) {
    res.status(401).json({ error: "Invalid bearer token" });
    return;
  }

  next();
}
