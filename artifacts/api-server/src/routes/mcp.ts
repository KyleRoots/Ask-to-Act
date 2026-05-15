import { Router, type IRouter, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerAuth } from "../middlewares/bearer-auth.js";
import { createMcpServer } from "../lib/mcp-server.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

router.post("/mcp", bearerAuth, async (req: Request, res: Response) => {
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("finish", () => {
      server.close().catch((err: unknown) => {
        logger.warn({ err }, "MCP server close error");
      });
    });
  } catch (err) {
    logger.error({ err }, "MCP request handler error");
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

router.get("/mcp", bearerAuth, async (req: Request, res: Response) => {
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
    res.on("finish", () => {
      server.close().catch((err: unknown) => {
        logger.warn({ err }, "MCP server close error (GET)");
      });
    });
  } catch (err) {
    logger.error({ err }, "MCP GET handler error");
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

export default router;
