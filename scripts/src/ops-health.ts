/**
 * CLI for AskToAct ops health (production or local).
 *
 * Auth: OPS_HEALTH_SECRET or ASKTOACT_MCP_API_KEY (service bearer).
 * Base: ASKTOACT_MCP_BASE_URL (default https://connect.asktoact.ai).
 *
 * Examples:
 *   pnpm --filter @workspace/scripts ops-health
 *   pnpm --filter @workspace/scripts ops-health -- --alert
 *   pnpm --filter @workspace/scripts ops-health -- --json
 */

const DEFAULT_BASE_URL = "https://connect.asktoact.ai";

function getToken(): string {
  const ops = process.env["OPS_HEALTH_SECRET"]?.trim();
  if (ops) return ops;
  const key = process.env["ASKTOACT_MCP_API_KEY"]?.trim();
  if (key) return key;
  throw new Error(
    "Set OPS_HEALTH_SECRET or ASKTOACT_MCP_API_KEY (Cursor Secrets / shell).",
  );
}

function getBaseUrl(): string {
  const raw = process.env["ASKTOACT_MCP_BASE_URL"]?.trim() || DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const alert = args.includes("--alert");
  const asJson = args.includes("--json");

  const url = new URL(`${getBaseUrl()}/api/internal/ops-health`);
  if (alert) url.searchParams.set("alert", "1");

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/json",
    },
  });

  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    console.error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
    process.exit(2);
  }

  if (asJson) {
    console.log(JSON.stringify(body, null, 2));
  } else {
    const status = String(body["status"] ?? "unknown");
    const summary = String(body["summary"] ?? "");
    console.log(`status: ${status}`);
    console.log(`summary: ${summary}`);
    if (typeof body["agentBrief"] === "string") {
      console.log("");
      console.log(body["agentBrief"]);
    }
    if (body["delivery"]) {
      console.log("");
      console.log("delivery:", JSON.stringify(body["delivery"]));
    }
  }

  const status = body["status"];
  if (status === "critical") process.exit(2);
  if (status === "warn") process.exit(1);
  if (!res.ok && status !== "ok") process.exit(2);
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
