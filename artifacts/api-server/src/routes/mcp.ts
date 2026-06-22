import { Router, type IRouter, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { bearerAuth } from "../middlewares/bearer-auth.js";
import { createMcpServer } from "../lib/mcp-server.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

async function handleMcpRequest(req: Request, res: Response, body?: unknown) {
  try {
    const server = createMcpServer(req.caller);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
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
}

router.post("/mcp", bearerAuth, (req, res) => handleMcpRequest(req, res, req.body));
router.get("/mcp", bearerAuth, (req, res) => handleMcpRequest(req, res));

router.post("/mcp/:token", bearerAuth, (req, res) =>
  handleMcpRequest(req, res, req.body),
);
router.get("/mcp/:token", bearerAuth, (req, res) => handleMcpRequest(req, res));

export default router;
