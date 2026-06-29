/**
 * Thin CLI client for the AskToAct MCP endpoint (connect.asktoact.ai/api/mcp).
 *
 * Auth: ASKTOACT_MCP_API_KEY (service MCP_BEARER_TOKEN or a portal user's api_key).
 * Base URL: ASKTOACT_MCP_BASE_URL (default https://connect.asktoact.ai).
 *
 * Examples:
 *   pnpm --filter @workspace/scripts asktoact-mcp tools/list
 *   pnpm --filter @workspace/scripts asktoact-mcp call describe_entity '{"entityType":"Candidate"}'
 *   pnpm --filter @workspace/scripts asktoact-mcp describe_entity Candidate
 */

const DEFAULT_BASE_URL = "https://connect.asktoact.ai";

function getApiKey(): string {
  const key = process.env["ASKTOACT_MCP_API_KEY"]?.trim();
  if (!key) {
    throw new Error(
      "ASKTOACT_MCP_API_KEY is not set. Add it in Cursor Cloud Agent Secrets " +
        "(cursor.com → Cloud Agents → Secrets) or export it in your shell.",
    );
  }
  return key;
}

function getBaseUrl(): string {
  const raw = process.env["ASKTOACT_MCP_BASE_URL"]?.trim() || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

type JsonRpcResponse = {
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
};

/** Parse Streamable HTTP SSE body into the last JSON-RPC message payload. */
function parseSseJsonRpcBody(body: string): JsonRpcResponse {
  const dataLines = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length).trim())
    .filter(Boolean);

  if (dataLines.length === 0) {
    // Some responses may be plain JSON (errors before SSE framing).
    try {
      return JSON.parse(body) as JsonRpcResponse;
    } catch {
      throw new Error(`Unexpected MCP response (not SSE or JSON): ${body.slice(0, 500)}`);
    }
  }

  const last = dataLines[dataLines.length - 1];
  return JSON.parse(last!) as JsonRpcResponse;
}

async function mcpRequest(
  method: string,
  params: Record<string, unknown> = {},
  id = 1,
): Promise<unknown> {
  const url = `${getBaseUrl()}/api/mcp`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

  const text = await res.text();
  if (!res.ok && !text.includes("jsonrpc")) {
    throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const payload = parseSseJsonRpcBody(text);
  if (payload.error) {
    const msg = payload.error.message ?? JSON.stringify(payload.error);
    throw new Error(`MCP error: ${msg}`);
  }
  return payload.result;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = (await mcpRequest("tools/call", {
    name,
    arguments: args,
  })) as { content?: Array<{ type?: string; text?: string }> };

  const textBlock = result?.content?.find((c) => c.type === "text" && c.text);
  if (textBlock?.text) {
    try {
      return JSON.parse(textBlock.text);
    } catch {
      return textBlock.text;
    }
  }
  return result;
}

function usage(): void {
  console.error(`Usage:
  asktoact-mcp tools/list
  asktoact-mcp call <toolName> '<json-args>'
  asktoact-mcp describe_entity <EntityType>

Environment:
  ASKTOACT_MCP_API_KEY     (required) Bearer token for /api/mcp
  ASKTOACT_MCP_BASE_URL    (optional) Default ${DEFAULT_BASE_URL}`);
}

async function main(): Promise<void> {
  const [, , cmd, arg1, arg2] = process.argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    process.exit(cmd ? 0 : 1);
  }

  let output: unknown;
  if (cmd === "tools/list") {
    output = await mcpRequest("tools/list", {});
  } else if (cmd === "call") {
    if (!arg1) throw new Error("call requires a tool name");
    const args = arg2 ? (JSON.parse(arg2) as Record<string, unknown>) : {};
    output = await callTool(arg1, args);
  } else if (cmd === "describe_entity") {
    if (!arg1) throw new Error("describe_entity requires an entity type (e.g. Candidate)");
    output = await callTool("describe_entity", { entityType: arg1 });
  } else {
    usage();
    process.exit(1);
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
